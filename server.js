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
    phase: 'lobby',
    settings: {
      answerTimeout:     settings.answerTimeout     || 10,
      mode:              settings.mode              || 'hard',
      autoContinue:      settings.autoContinue      ?? true,
      autoContinueDelay: settings.autoContinueDelay || 10,
    },
    players: {},          // socketId → { name, score, eliminatedThisRound }
    wordQueue: shuffle(Object.keys(dictionary)),
    wordQueueIndex: 0,
    roundNumber: 0,
    currentClueIndex: 0,
    revealedClues: [],
    answeringPlayerId: null,
    answerTimer: null,
    activeAnswerers: {},
    answerTimers: {},
    clueTimer: null,
    autoContinueTimer: null,
  };
  return code;
}

function currentEntry(room) {
  const id = room.wordQueue[room.wordQueueIndex % room.wordQueue.length];
  return { id, entry: dictionary[id] };
}

function roomState(room) {
  const { mode } = room.settings;
  const activeNames = mode === 'chaos'
    ? Object.keys(room.activeAnswerers).map(id => room.players[id]?.name).filter(Boolean)
    : (room.answeringPlayerId ? [room.players[room.answeringPlayerId]?.name].filter(Boolean) : []);

  return {
    code: room.code,
    phase: room.phase,
    roundNumber: room.roundNumber,
    settings: room.settings,
    hostSocketId: room.hostSocketId,
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
  if (room.clueTimer)        { clearTimeout(room.clueTimer);        room.clueTimer        = null; }
  if (room.answerTimer)      { clearTimeout(room.answerTimer);      room.answerTimer      = null; }
  if (room.autoContinueTimer){ clearTimeout(room.autoContinueTimer); room.autoContinueTimer = null; }
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

  // Auto-continue
  const { autoContinue, autoContinueDelay } = room.settings;
  if (autoContinue && Object.keys(room.players).length > 0) {
    io.to(roomCode).emit('auto_continue_started', { delay: autoContinueDelay });
    room.autoContinueTimer = setTimeout(() => {
      if (rooms[roomCode]?.phase === 'round_over') startRound(roomCode);
    }, autoContinueDelay * 1000);
  }
}

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

// ── Start round (shared by socket handler + auto-continue) ──────────────────
function startRound(roomCode) {
  const room = rooms[roomCode];
  if (!room) return 'חדר לא נמצא';
  if (!['lobby', 'round_over'].includes(room.phase)) return 'לא ניתן כרגע';

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
  io.to(roomCode).emit('round_started', {
    roundNumber: room.roundNumber,
    totalClues: entry.clues.length,
    roomState: roomState(room),
  });

  scheduleNextClue(roomCode);
  return null;
}

// ── Socket events ──────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('connected:', socket.id);

  // Host creates room — host is also a player
  socket.on('create_room', ({ playerName, settings } = {}, cb) => {
    const name = playerName?.trim() || 'מארח';
    const code = createRoom(socket.id, settings || {});
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.isHost = true;

    // Host is a player like everyone else
    rooms[code].players[socket.id] = { name, score: 0, eliminatedThisRound: false };

    cb({ code, roomState: roomState(rooms[code]) });
    console.log(`Room ${code} | host: ${name} | mode: ${rooms[code].settings.mode}`);
  });

  // Player joins
  socket.on('join_room', ({ code, playerName }, cb) => {
    const room = rooms[code?.toUpperCase()];
    if (!room) return cb({ error: 'חדר לא נמצא' });
    if (!playerName?.trim()) return cb({ error: 'נא להזין שם' });
    if (room.phase !== 'lobby' && room.phase !== 'round_over')
      return cb({ error: 'המשחק בעיצומו — הצטרפו בסיבוב הבא' });

    socket.join(code.toUpperCase());
    socket.data.roomCode = code.toUpperCase();
    socket.data.isHost = false;
    room.players[socket.id] = { name: playerName.trim(), score: 0, eliminatedThisRound: false };

    cb({ roomState: roomState(room) });
    io.to(code.toUpperCase()).emit('room_updated', roomState(room));
  });

  // Host starts round
  socket.on('start_round', (_, cb) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || socket.id !== room.hostSocketId) return cb?.({ error: 'רק המארח יכול להתחיל' });
    const err = startRound(code);
    cb?.(err ? { error: err } : { ok: true });
  });

  // Host pauses auto-continue
  socket.on('pause_auto_continue', (_, cb) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || socket.id !== room.hostSocketId) return;
    if (room.autoContinueTimer) { clearTimeout(room.autoContinueTimer); room.autoContinueTimer = null; }
    io.to(code).emit('auto_continue_paused');
    cb?.({ ok: true });
  });

  // Host resumes auto-continue (resets full delay)
  socket.on('resume_auto_continue', (_, cb) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || socket.id !== room.hostSocketId) return;
    if (room.phase !== 'round_over') return;
    const delay = room.settings.autoContinueDelay;
    if (room.autoContinueTimer) clearTimeout(room.autoContinueTimer);
    io.to(code).emit('auto_continue_started', { delay });
    room.autoContinueTimer = setTimeout(() => {
      if (rooms[code]?.phase === 'round_over') startRound(code);
    }, delay * 1000);
    cb?.({ ok: true });
  });

  // Any player presses buzzer
  socket.on('press_buzzer', (_, cb) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room) return cb?.({ error: 'חדר לא נמצא' });

    const player = room.players[socket.id];
    if (!player) return cb?.({ error: 'אינך רשום כשחקן' });

    const { mode, answerTimeout } = room.settings;
    const timeoutMs = answerTimeout * 1000;

    if (mode === 'chaos') {
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

  // Player submits grid answer
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

      socket.emit('answer_result', { correct, ...(correct ? { word: entry.word } : {}) });

      if (correct) {
        const points = Math.max(1, entry.clues.length - room.revealedClues.length + 1);
        endRound(code, socket.id, points);
      } else {
        io.to(code).emit('answer_failed', {
          playerName: room.players[socket.id]?.name,
          eliminated: false,
          roomState: roomState(room),
        });
      }

    } else {
      if (room.phase !== 'player_answering' || socket.id !== room.answeringPlayerId) return;
      if (room.answerTimer) { clearTimeout(room.answerTimer); room.answerTimer = null; }

      socket.emit('answer_result', { correct, ...(correct ? { word: entry.word } : {}) });

      if (correct) {
        const points = Math.max(1, entry.clues.length - room.revealedClues.length + 1);
        endRound(code, socket.id, points);
      } else {
        handleWrongAnswer(code, socket.id);
      }
    }

    cb?.({ ok: true });
  });


  // Player voluntarily leaves (back to home screen)
  socket.on('leave_game', (_, cb) => {
    const code = socket.data?.roomCode;
    const room = rooms[code];

    // Leave the socket.io room immediately — no more broadcast events reach this socket
    socket.leave(code);
    socket.data.roomCode = null;

    if (!room) { cb?.({ ok: true }); return; }

    // Clean up any chaos answer timers for this player
    if (room.answerTimers?.[socket.id]) {
      clearTimeout(room.answerTimers[socket.id]);
      delete room.answerTimers[socket.id];
    }
    delete room.activeAnswerers[socket.id];

    if (socket.id === room.hostSocketId) {
      // Host leaving ends the session for everyone
      stopAllTimers(room);
      io.to(code).emit('game_ended', { reason: 'המארח עזב את המשחק' });
      delete rooms[code];
    } else {
      const wasAnswering = room.answeringPlayerId === socket.id && room.phase === 'player_answering';
      const playerName = room.players[socket.id]?.name;
      delete room.players[socket.id];

      if (wasAnswering) {
        // Resume as if they timed out
        room.answeringPlayerId = null;
        if (room.answerTimer) { clearTimeout(room.answerTimer); room.answerTimer = null; }
        const active = Object.values(room.players).filter(p => !p.eliminatedThisRound);
        if (active.length === 0) {
          endRound(code, null, 0);
        } else {
          room.phase = 'clues_running';
          io.to(code).emit('answer_failed', { playerName, eliminated: false, roomState: roomState(room) });
          scheduleNextClue(code);
        }
      } else {
        // Check if everyone is now eliminated
        const active = Object.values(room.players).filter(p => !p.eliminatedThisRound);
        if (active.length === 0 && room.phase === 'clues_running') {
          endRound(code, null, 0);
        } else {
          io.to(code).emit('room_updated', roomState(room));
        }
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

server.listen(PORT, () => console.log(`Buzzer server on port ${PORT}`));
