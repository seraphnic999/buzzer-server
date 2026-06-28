const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const dictionary = require('./dictionary.json');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["https://buzzer-client-ten.vercel.app", "http://localhost:5173"],
    methods: ["GET", "POST"],
  },
});
const PORT = process.env.PORT || 3002;

const CLUE_INTERVAL_MS = 3500;
const GRACE_PERIOD_MS  = 6000;

// ── Helpers ────────────────────────────────────────────────────────────────
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function generateCode() {
  return Array.from({ length: 5 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join('');
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Room store ─────────────────────────────────────────────────────────────
const rooms = {};

function createRoom(hostSocketId, settings = {}) {
  const code = generateCode();
  rooms[code] = {
    code,
    hostSocketId,
    phase: 'lobby',       // lobby | clues_running | player_answering | round_over
    settings: {
      answerTimeout: settings.answerTimeout || 10, // seconds
      mode: settings.mode || 'hard',               // easy | hard | chaos
    },
    players: {},           // socketId → { name, score, eliminatedThisRound }
    wordQueue: shuffle(Object.keys(dictionary)),
    wordQueueIndex: 0,
    roundNumber: 0,
    currentClueIndex: 0,
    revealedClues: [],
    // easy/hard: single answerer
    answeringPlayerId: null,
    answerTimer: null,
    // chaos: multiple simultaneous answerers
    activeAnswerers: {},   // socketId → true
    answerTimers: {},      // socketId → timeout handle
    clueTimer: null,
  };
  return code;
}

function currentEntry(room) {
  const id = room.wordQueue[room.wordQueueIndex % room.wordQueue.length];
  return { id, entry: dictionary[id] };
}

function roomState(room) {
  const { mode } = room.settings;
  // For host display: who is currently in the grid
  const activeNames = mode === 'chaos'
    ? Object.keys(room.activeAnswerers).map(id => room.players[id]?.name).filter(Boolean)
    : (room.answeringPlayerId ? [room.players[room.answeringPlayerId]?.name].filter(Boolean) : []);

  return {
    code: room.code,
    phase: room.phase,
    roundNumber: room.roundNumber,
    settings: room.settings,
    players: Object.entries(room.players).map(([id, p]) => ({
      id, name: p.name, score: p.score, eliminatedThisRound: p.eliminatedThisRound,
    })),
    revealedClues: room.revealedClues,
    totalClues: currentEntry(room).entry?.clues?.length ?? 0,
    activeAnswererNames: activeNames,
  };
}

// ── Timer helpers ──────────────────────────────────────────────────────────
function stopAllTimers(room) {
  if (room.clueTimer)  { clearTimeout(room.clueTimer);  room.clueTimer  = null; }
  if (room.answerTimer){ clearTimeout(room.answerTimer); room.answerTimer = null; }
  for (const id of Object.keys(room.answerTimers || {})) clearTimeout(room.answerTimers[id]);
  room.answerTimers = {};
  room.activeAnswerers = {};
}

function scheduleNextClue(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.phase !== 'clues_running') return;

  const { entry } = currentEntry(room);
  const idx = room.currentClueIndex;

  if (idx >= entry.clues.length) {
    room.clueTimer = setTimeout(() => {
      if (rooms[roomCode]?.phase === 'clues_running') endRound(roomCode, null, 0);
    }, GRACE_PERIOD_MS);
    return;
  }

  const clue = entry.clues[idx];
  room.revealedClues.push({ index: idx, text: clue });
  room.currentClueIndex++;

  io.to(roomCode).emit('clue_revealed', {
    clueIndex: idx, clue,
    revealedClues: room.revealedClues,
    totalClues: entry.clues.length,
  });

  room.clueTimer = setTimeout(() => scheduleNextClue(roomCode), CLUE_INTERVAL_MS);
}

function endRound(roomCode, winnerId, points) {
  const room = rooms[roomCode];
  if (!room) return;
  stopAllTimers(room);
  room.phase = 'round_over';
  room.answeringPlayerId = null;

  if (winnerId && room.players[winnerId]) {
    room.players[winnerId].score += points;
  }

  const { entry } = currentEntry(room);
  io.to(roomCode).emit('round_over', {
    word: entry.word,
    winnerName: winnerId ? (room.players[winnerId]?.name ?? null) : null,
    points,
    roomState: roomState(room),
  });
}

// Called after a wrong answer in easy/hard mode
function handleWrongAnswer(roomCode, playerId) {
  const room = rooms[roomCode];
  if (!room) return;

  const { mode } = room.settings;
  const eliminated = mode === 'hard';

  room.answeringPlayerId = null;
  room.answerTimer = null;

  if (eliminated && room.players[playerId]) {
    room.players[playerId].eliminatedThisRound = true;
    const active = Object.values(room.players).filter(p => !p.eliminatedThisRound);
    if (active.length === 0) { endRound(roomCode, null, 0); return; }
  }

  room.phase = 'clues_running';
  io.to(roomCode).emit('answer_failed', {
    playerName: room.players[playerId]?.name,
    eliminated,
    roomState: roomState(room),
  });

  scheduleNextClue(roomCode);
}

// ── Socket events ──────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('connected:', socket.id);

  socket.on('create_room', ({ settings } = {}, cb) => {
    const code = createRoom(socket.id, settings || {});
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.isHost = true;
    cb({ code, roomState: roomState(rooms[code]) });
    console.log(`Room ${code} created — mode: ${rooms[code].settings.mode}, timeout: ${rooms[code].settings.answerTimeout}s`);
  });

  socket.on('join_room', ({ code, playerName }, cb) => {
    const room = rooms[code?.toUpperCase()];
    if (!room) return cb({ error: 'חדר לא נמצא' });
    if (!playerName?.trim()) return cb({ error: 'נא להזין שם' });
    if (room.phase !== 'lobby' && room.phase !== 'round_over')
      return cb({ error: 'המשחק כבר בעיצומו — תצטרפו בסיבוב הבא' });

    socket.join(code.toUpperCase());
    socket.data.roomCode = code.toUpperCase();
    socket.data.isHost = false;
    room.players[socket.id] = { name: playerName.trim(), score: 0, eliminatedThisRound: false };

    cb({ roomState: roomState(room) });
    io.to(code.toUpperCase()).emit('room_updated', roomState(room));
  });

  socket.on('start_round', (_, cb) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || socket.id !== room.hostSocketId) return;
    if (!['lobby', 'round_over'].includes(room.phase)) return cb?.({ error: 'לא ניתן כרגע' });
    if (Object.keys(room.players).length === 0) return cb?.({ error: 'צריך לפחות שחקן אחד' });

    if (room.roundNumber > 0) room.wordQueueIndex++;
    room.roundNumber++;
    room.phase = 'clues_running';
    room.currentClueIndex = 0;
    room.revealedClues = [];
    room.answeringPlayerId = null;
    stopAllTimers(room);

    for (const pid of Object.keys(room.players)) {
      room.players[pid].eliminatedThisRound = false;
    }

    const { entry } = currentEntry(room);
    io.to(code).emit('round_started', {
      roundNumber: room.roundNumber,
      totalClues: entry.clues.length,
      roomState: roomState(room),
    });

    scheduleNextClue(code);
    cb?.({ ok: true });
  });

  socket.on('press_buzzer', (_, cb) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room) return cb?.({ error: 'חדר לא נמצא' });

    const player = room.players[socket.id];
    if (!player) return cb?.({ error: 'אינך רשום כשחקן' });

    const { mode, answerTimeout } = room.settings;
    const timeoutMs = answerTimeout * 1000;

    if (mode === 'chaos') {
      // Chaos: clues keep running, multiple can buzz simultaneously
      if (room.phase !== 'clues_running') return cb?.({ error: 'לא ניתן כרגע' });
      if (room.activeAnswerers[socket.id]) return cb?.({ error: 'כבר בוחר תשובה' });

      room.activeAnswerers[socket.id] = true;
      const { entry } = currentEntry(room);

      io.to(code).emit('player_buzzed', { playerName: player.name, roomState: roomState(room) });
      socket.emit('show_grid', { grid: shuffle(entry.grid), timeLimit: answerTimeout });

      room.answerTimers[socket.id] = setTimeout(() => {
        const r = rooms[code];
        if (!r || !r.activeAnswerers[socket.id]) return;
        delete r.activeAnswerers[socket.id];
        delete r.answerTimers[socket.id];
        socket.emit('answer_result', { correct: false, timeout: true });
        io.to(code).emit('answer_failed', {
          playerName: player.name, eliminated: false, roomState: roomState(r),
        });
      }, timeoutMs);

    } else {
      // Easy / Hard: pause clues, single answerer
      if (room.phase !== 'clues_running') return cb?.({ error: 'לא ניתן כרגע' });
      if (player.eliminatedThisRound) return cb?.({ error: 'אתה מחוץ לסיבוב הזה' });

      stopAllTimers(room);
      room.phase = 'player_answering';
      room.answeringPlayerId = socket.id;

      const { entry } = currentEntry(room);
      io.to(code).emit('player_buzzed', { playerName: player.name, roomState: roomState(room) });
      socket.emit('show_grid', { grid: shuffle(entry.grid), timeLimit: answerTimeout });

      room.answerTimer = setTimeout(() => {
        const r = rooms[code];
        if (!r || r.phase !== 'player_answering' || r.answeringPlayerId !== socket.id) return;
        socket.emit('answer_result', { correct: false, timeout: true });
        handleWrongAnswer(code, socket.id);
      }, timeoutMs);
    }

    cb?.({ ok: true });
  });

  socket.on('submit_answer', ({ answer }, cb) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room) return;

    const { mode } = room.settings;
    const { entry } = currentEntry(room);
    const correct = answer === entry.word;

    if (mode === 'chaos') {
      if (!room.activeAnswerers[socket.id]) return;
      clearTimeout(room.answerTimers[socket.id]);
      delete room.answerTimers[socket.id];
      delete room.activeAnswerers[socket.id];

      socket.emit('answer_result', { correct, word: entry.word });

      if (correct) {
        const points = Math.max(1, entry.clues.length - room.revealedClues.length + 1);
        endRound(code, socket.id, points);
      } else {
        // Chaos: wrong but can buzz again immediately
        io.to(code).emit('answer_failed', {
          playerName: room.players[socket.id]?.name,
          eliminated: false,
          roomState: roomState(room),
        });
      }

    } else {
      if (room.phase !== 'player_answering' || socket.id !== room.answeringPlayerId) return;
      if (room.answerTimer) { clearTimeout(room.answerTimer); room.answerTimer = null; }

      socket.emit('answer_result', { correct, word: entry.word });

      if (correct) {
        const points = Math.max(1, entry.clues.length - room.revealedClues.length + 1);
        endRound(code, socket.id, points);
      } else {
        handleWrongAnswer(code, socket.id);
      }
    }

    cb?.({ ok: true });
  });

  socket.on('disconnect', () => {
    const code = socket.data?.roomCode;
    const room = rooms[code];
    if (!room) return;

    if (socket.id === room.hostSocketId) {
      stopAllTimers(room);
      io.to(code).emit('game_ended', { reason: 'המארח התנתק' });
      delete rooms[code];
    } else {
      // Clean up chaos timers for this player
      if (room.answerTimers?.[socket.id]) {
        clearTimeout(room.answerTimers[socket.id]);
        delete room.answerTimers[socket.id];
        delete room.activeAnswerers[socket.id];
      }
      delete room.players[socket.id];
      if (room.answeringPlayerId === socket.id && room.phase === 'player_answering') {
        handleWrongAnswer(code, socket.id);
      } else {
        io.to(code).emit('room_updated', roomState(room));
      }
    }
  });
});

server.listen(PORT, () => console.log(`Buzzer server running on port ${PORT}`));
