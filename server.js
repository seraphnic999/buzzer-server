const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const dictionary = require('./dictionary.json');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
const PORT = process.env.PORT || 3002;

// ── Constants ──────────────────────────────────────────────────────────────
const CLUE_INTERVAL_MS = 3500;   // ms between clues
const GRACE_PERIOD_MS  = 6000;   // ms after last clue before auto round-end
const ANSWER_TIMEOUT_MS = 15000; // ms player has to pick from grid

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

function createRoom(hostSocketId) {
  const code = generateCode();
  rooms[code] = {
    code,
    hostSocketId,
    phase: 'lobby',       // lobby | clues_running | player_answering | round_over
    players: {},          // socketId → { name, score, eliminatedThisRound }
    wordQueue: shuffle(Object.keys(dictionary)),
    wordQueueIndex: 0,
    roundNumber: 0,
    currentClueIndex: 0,
    revealedClues: [],    // [{ index, text }]
    answeringPlayerId: null,
    clueTimer: null,
    answerTimer: null,
  };
  return code;
}

function currentEntry(room) {
  const id = room.wordQueue[room.wordQueueIndex % room.wordQueue.length];
  return { id, entry: dictionary[id] };
}

function roomState(room) {
  return {
    code: room.code,
    phase: room.phase,
    roundNumber: room.roundNumber,
    players: Object.entries(room.players).map(([id, p]) => ({
      id, name: p.name, score: p.score, eliminatedThisRound: p.eliminatedThisRound,
    })),
    revealedClues: room.revealedClues,
    totalClues: currentEntry(room).entry?.clues?.length ?? 0,
    answeringPlayerName: room.answeringPlayerId
      ? (room.players[room.answeringPlayerId]?.name ?? null)
      : null,
  };
}

// ── Timer helpers ──────────────────────────────────────────────────────────
function stopTimers(room) {
  if (room.clueTimer)  { clearTimeout(room.clueTimer);  room.clueTimer  = null; }
  if (room.answerTimer){ clearTimeout(room.answerTimer); room.answerTimer = null; }
}

function scheduleNextClue(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.phase !== 'clues_running') return;

  const { entry } = currentEntry(room);
  const idx = room.currentClueIndex;

  if (idx >= entry.clues.length) {
    // All clues shown — grace period then auto end
    room.clueTimer = setTimeout(() => {
      if (rooms[roomCode]?.phase === 'clues_running') endRound(roomCode, null, 0);
    }, GRACE_PERIOD_MS);
    return;
  }

  // Reveal clue at idx
  const clue = entry.clues[idx];
  room.revealedClues.push({ index: idx, text: clue });
  room.currentClueIndex++;

  io.to(roomCode).emit('clue_revealed', {
    clueIndex: idx,
    clue,
    revealedClues: room.revealedClues,
    totalClues: entry.clues.length,
  });

  // Schedule the next one
  room.clueTimer = setTimeout(() => scheduleNextClue(roomCode), CLUE_INTERVAL_MS);
}

function endRound(roomCode, winnerId, points) {
  const room = rooms[roomCode];
  if (!room) return;
  stopTimers(room);
  room.phase = 'round_over';

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

function eliminateAndResume(roomCode, playerId) {
  const room = rooms[roomCode];
  if (!room) return;

  if (room.players[playerId]) room.players[playerId].eliminatedThisRound = true;
  room.answeringPlayerId = null;

  const active = Object.values(room.players).filter(p => !p.eliminatedThisRound);
  if (active.length === 0) { endRound(roomCode, null, 0); return; }

  room.phase = 'clues_running';
  io.to(roomCode).emit('player_eliminated', { roomState: roomState(room) });

  // Resume clue chain (advance one clue as small penalty for the pause)
  scheduleNextClue(roomCode);
}

// ── Socket events ──────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('connected:', socket.id);

  // Host creates a room
  socket.on('create_room', (_, cb) => {
    const code = createRoom(socket.id);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.isHost = true;
    cb({ code, roomState: roomState(rooms[code]) });
    console.log('Room created:', code);
  });

  // Player joins
  socket.on('join_room', ({ code, playerName }, cb) => {
    const room = rooms[code?.toUpperCase()];
    if (!room) return cb({ error: 'חדר לא נמצא' });
    if (!playerName?.trim()) return cb({ error: 'נא להזין שם' });
    if (room.phase !== 'lobby' && room.phase !== 'round_over') return cb({ error: 'המשחק כבר בעיצומו — תצטרפו בסיבוב הבא' });

    socket.join(code.toUpperCase());
    socket.data.roomCode = code.toUpperCase();
    socket.data.isHost = false;

    room.players[socket.id] = { name: playerName.trim(), score: 0, eliminatedThisRound: false };

    cb({ roomState: roomState(room) });
    io.to(code.toUpperCase()).emit('room_updated', roomState(room));
  });

  // Host starts a round
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
    stopTimers(room);

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

  // Player presses buzzer
  socket.on('press_buzzer', (_, cb) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || room.phase !== 'clues_running') return cb?.({ error: 'לא ניתן כרגע' });

    const player = room.players[socket.id];
    if (!player) return cb?.({ error: 'אינך רשום כשחקן' });
    if (player.eliminatedThisRound) return cb?.({ error: 'אתה מחוץ לסיבוב הזה' });

    stopTimers(room);
    room.phase = 'player_answering';
    room.answeringPlayerId = socket.id;

    const { entry } = currentEntry(room);
    const shuffledGrid = shuffle(entry.grid);

    io.to(code).emit('player_buzzed', {
      playerName: player.name,
      roomState: roomState(room),
    });

    // Grid goes ONLY to the buzzing player
    socket.emit('show_grid', { grid: shuffledGrid, timeLimit: ANSWER_TIMEOUT_MS / 1000 });

    // Server-side answer timeout
    room.answerTimer = setTimeout(() => {
      if (rooms[code]?.phase === 'player_answering' && rooms[code]?.answeringPlayerId === socket.id) {
        socket.emit('answer_result', { correct: false, timeout: true });
        eliminateAndResume(code, socket.id);
      }
    }, ANSWER_TIMEOUT_MS);

    cb?.({ ok: true });
  });

  // Player submits grid answer
  socket.on('submit_answer', ({ answer }, cb) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || room.phase !== 'player_answering') return;
    if (socket.id !== room.answeringPlayerId) return;

    stopTimers(room);
    const { entry } = currentEntry(room);
    const correct = answer === entry.word;

    socket.emit('answer_result', { correct, word: entry.word });

    if (correct) {
      const points = Math.max(1, entry.clues.length - room.revealedClues.length + 1);
      endRound(code, socket.id, points);
    } else {
      eliminateAndResume(code, socket.id);
    }

    cb?.({ ok: true });
  });

  socket.on('disconnect', () => {
    const code = socket.data?.roomCode;
    const room = rooms[code];
    if (!room) return;

    if (socket.id === room.hostSocketId) {
      stopTimers(room);
      io.to(code).emit('game_ended', { reason: 'המארח התנתק' });
      delete rooms[code];
    } else {
      delete room.players[socket.id];
      if (room.answeringPlayerId === socket.id && room.phase === 'player_answering') {
        eliminateAndResume(code, socket.id);
      } else {
        io.to(code).emit('room_updated', roomState(room));
      }
    }
  });
});

server.listen(PORT, () => console.log(`Buzzer server running on port ${PORT}`));
