const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

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
const HOST_RECONNECT_GRACE_MS = 5 * 60 * 1000; // 5 minutes

// ── Dictionary loading ─────────────────────────────────────────────────────────
function loadDictionaries() {
  const dataDir = path.join(__dirname, 'data');
  const entries = [];
  if (!fs.existsSync(dataDir)) { console.error('⚠ No data/ directory found'); return entries; }
  const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.json') && f !== 'README.md').sort();
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(dataDir, file), 'utf-8');
      const data = JSON.parse(raw);
      const fileEntries = Array.isArray(data.entries) ? data.entries : [];
      const cat = data.category_name
        || (typeof data.category === 'object' ? data.category?.name : data.category)
        || data.category_id || file;
      for (const e of fileEntries) {
        if (!e.answer || !Array.isArray(e.clues) || !Array.isArray(e.grid)) continue;
        entries.push({ word: e.answer, clues: e.clues, grid: e.grid, category: e.category_name || cat });
      }
      console.log(`  ✓ ${file}: ${fileEntries.length} entries (${cat})`);
    } catch (err) { console.error(`  ✗ ${file}: ${err.message}`); }
  }
  return entries;
}
console.log('Loading dictionaries...');
const DICTIONARY = loadDictionaries();
console.log(`Total: ${DICTIONARY.length} words\n`);

// ── Helpers ────────────────────────────────────────────────────────────────────
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

// ── Room store ─────────────────────────────────────────────────────────────────
const rooms = {};

function createRoom(hostSocketId, hostName, settings = {}) {
  const code = generateCode();
  rooms[code] = {
    code,
    hostSocketId,
    hostName,            // used to identify host on rejoin
    hostConnected: true,
    phase: 'lobby',
    settings: {
      answerTimeout:     settings.answerTimeout     || 10,
      mode:              settings.mode              || 'hard',
      autoContinue:      settings.autoContinue      ?? true,
      autoContinueDelay: settings.autoContinueDelay || 10,
    },
    players: {},
    // Disconnected players saved by name so they can rejoin and recover their score
    disconnectedPlayers: {}, // name → { score, wasHost, pendingNextTurn }
    wordQueue: shuffle([...Array(DICTIONARY.length).keys()]),
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
    cleanupTimer: null,   // fires to delete room if host never rejoins
  };
  return code;
}

function currentEntry(room) {
  const idx = room.wordQueue[room.wordQueueIndex % room.wordQueue.length];
  return DICTIONARY[idx] || { word: '???', clues: Array(10).fill('...'), grid: [] };
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
    hostName: room.hostName,
    hostConnected: room.hostConnected,
    players: Object.entries(room.players).map(([id, p]) => ({
      id, name: p.name, score: p.score,
      eliminatedThisRound: p.eliminatedThisRound,
      pendingNextTurn: p.pendingNextTurn || false,
    })),
    revealedClues: room.revealedClues,
    totalClues: currentEntry(room)?.clues?.length ?? 0,
    activeAnswererNames: activeNames,
  };
}

// ── Timer helpers ──────────────────────────────────────────────────────────────
function stopAllTimers(room) {
  if (room.clueTimer)        { clearTimeout(room.clueTimer);        room.clueTimer        = null; }
  if (room.answerTimer)      { clearTimeout(room.answerTimer);      room.answerTimer      = null; }
  if (room.autoContinueTimer){ clearTimeout(room.autoContinueTimer); room.autoContinueTimer = null; }
  if (room.cleanupTimer)     { clearTimeout(room.cleanupTimer);     room.cleanupTimer     = null; }
  for (const id of Object.keys(room.answerTimers || {})) clearTimeout(room.answerTimers[id]);
  room.answerTimers = {};
  room.activeAnswerers = {};
}

function scheduleNextClue(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.phase !== 'clues_running') return;
  const entry = currentEntry(room);
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
  if (winnerId && room.players[winnerId]) room.players[winnerId].score += points;
  const entry = currentEntry(room);
  io.to(roomCode).emit('round_over', {
    word: entry.word,
    category: entry.category,
    winnerName: winnerId ? (room.players[winnerId]?.name ?? null) : null,
    points,
    roomState: roomState(room),
  });
  // Auto-continue: use all players (including pending ones — they'll be active next turn)
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
    // Only count non-pending players for elimination check
    const active = Object.values(room.players).filter(p => !p.eliminatedThisRound && !p.pendingNextTurn);
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

// ── Start round ────────────────────────────────────────────────────────────────
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
    room.players[pid].pendingNextTurn = false; // pending players become active on new round
  }
  const entry = currentEntry(room);
  io.to(roomCode).emit('round_started', {
    roundNumber: room.roundNumber,
    totalClues: entry.clues.length,
    category: entry.category,
    roomState: roomState(room),
  });
  scheduleNextClue(roomCode);
  return null;
}

// ── Socket events ──────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('connected:', socket.id);

  // Host creates room
  socket.on('create_room', ({ playerName, settings } = {}, cb) => {
    const name = playerName?.trim() || 'מארח';
    const code = createRoom(socket.id, name, settings || {});
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.isHost = true;
    rooms[code].players[socket.id] = { name, score: 0, eliminatedThisRound: false, pendingNextTurn: false };
    cb({ code, roomState: roomState(rooms[code]) });
    console.log(`Room ${code} | host: ${name} | mode: ${rooms[code].settings.mode}`);
  });

  // Player joins — handles both new joins AND reconnects (by name match in disconnectedPlayers)
  socket.on('join_room', ({ code, playerName }, cb) => {
    const roomCode = code?.toUpperCase();
    const room = rooms[roomCode];
    if (!room) return cb({ error: 'חדר לא נמצא' });
    if (!playerName?.trim()) return cb({ error: 'נא להזין שם' });
    const name = playerName.trim();

    // Check if reconnecting (name previously in this room)
    const prevData = room.disconnectedPlayers[name];
    const wasHost = prevData?.wasHost || false;

    // Check for name collision with active player
    const nameTaken = Object.values(room.players).some(p => p.name === name);
    if (nameTaken && !prevData) {
      return cb({ error: 'שם זה כבר בשימוש בחדר זה' });
    }

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.isHost = wasHost;

    // If reconnecting as host, restore host role
    if (wasHost) {
      room.hostSocketId = socket.id;
      room.hostConnected = true;
      if (room.cleanupTimer) { clearTimeout(room.cleanupTimer); room.cleanupTimer = null; }
    }

    // Pending if joining mid-game as a NEW player (not reconnecting)
    const isMidGame = !['lobby', 'round_over'].includes(room.phase);
    const pendingNextTurn = !wasHost && !prevData && isMidGame;

    room.players[socket.id] = {
      name,
      score: prevData?.score || 0,
      eliminatedThisRound: false,
      pendingNextTurn,
    };

    // Clear from disconnected list
    if (prevData) delete room.disconnectedPlayers[name];

    cb({
      roomState: roomState(room),
      isHost: wasHost,
      pendingNextTurn,
      resumed: !!prevData,
    });

    if (wasHost) {
      io.to(roomCode).emit('host_reconnected', { hostName: name, roomState: roomState(room) });
    } else {
      io.to(roomCode).emit('room_updated', roomState(room));
    }
  });

  // Host starts round
  socket.on('start_round', (_, cb) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || socket.id !== room.hostSocketId) return cb?.({ error: 'רק המארח יכול להתחיל' });
    const err = startRound(code);
    cb?.(err ? { error: err } : { ok: true });
  });

  socket.on('pause_auto_continue', (_, cb) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || socket.id !== room.hostSocketId) return;
    if (room.autoContinueTimer) { clearTimeout(room.autoContinueTimer); room.autoContinueTimer = null; }
    io.to(code).emit('auto_continue_paused');
    cb?.({ ok: true });
  });

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

  socket.on('press_buzzer', (_, cb) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room) return cb?.({ error: 'חדר לא נמצא' });
    const player = room.players[socket.id];
    if (!player) return cb?.({ error: 'אינך רשום כשחקן' });
    // Block pending players from buzzing
    if (player.pendingNextTurn) return cb?.({ error: 'תצטרף לסיבוב הבא' });
    const { mode, answerTimeout } = room.settings;
    const timeoutMs = answerTimeout * 1000;

    if (mode === 'chaos') {
      if (room.phase !== 'clues_running') return cb?.({ error: 'לא ניתן כרגע' });
      if (room.activeAnswerers[socket.id]) return cb?.({ error: 'כבר בוחר תשובה' });
      room.activeAnswerers[socket.id] = true;
      const entry = currentEntry(room);
      io.to(code).emit('player_buzzed', { playerName: player.name, roomState: roomState(room) });
      socket.emit('show_grid', { grid: shuffle(entry.grid), timeLimit: answerTimeout });
      room.answerTimers[socket.id] = setTimeout(() => {
        const r = rooms[code];
        if (!r || !r.activeAnswerers[socket.id]) return;
        delete r.activeAnswerers[socket.id];
        delete r.answerTimers[socket.id];
        socket.emit('answer_result', { correct: false, timeout: true });
        io.to(code).emit('answer_failed', { playerName: player.name, eliminated: false, roomState: roomState(r) });
      }, timeoutMs);
    } else {
      if (room.phase !== 'clues_running') return cb?.({ error: 'לא ניתן כרגע' });
      if (player.eliminatedThisRound) return cb?.({ error: 'אתה מחוץ לסיבוב הזה' });
      stopAllTimers(room);
      room.phase = 'player_answering';
      room.answeringPlayerId = socket.id;
      const entry = currentEntry(room);
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
    const entry = currentEntry(room);
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
        io.to(code).emit('answer_failed', { playerName: room.players[socket.id]?.name, eliminated: false, roomState: roomState(room) });
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

  // Voluntary leave (go home button)
  socket.on('leave_game', (_, cb) => {
    const code = socket.data?.roomCode;
    const room = rooms[code];
    socket.leave(code);
    socket.data.roomCode = null;
    if (!room) { cb?.({ ok: true }); return; }
    if (room.answerTimers?.[socket.id]) {
      clearTimeout(room.answerTimers[socket.id]);
      delete room.answerTimers[socket.id];
    }
    delete room.activeAnswerers[socket.id];
    if (socket.id === room.hostSocketId) {
      // Host voluntarily left — end game
      stopAllTimers(room);
      io.to(code).emit('game_ended', { reason: 'המארח עזב את המשחק' });
      delete rooms[code];
    } else {
      const wasAnswering = room.answeringPlayerId === socket.id && room.phase === 'player_answering';
      const playerName = room.players[socket.id]?.name;
      delete room.players[socket.id];
      if (wasAnswering) {
        room.answeringPlayerId = null;
        if (room.answerTimer) { clearTimeout(room.answerTimer); room.answerTimer = null; }
        const active = Object.values(room.players).filter(p => !p.eliminatedThisRound && !p.pendingNextTurn);
        if (active.length === 0) {
          endRound(code, null, 0);
        } else {
          room.phase = 'clues_running';
          io.to(code).emit('answer_failed', { playerName, eliminated: false, roomState: roomState(room) });
          scheduleNextClue(code);
        }
      } else {
        const active = Object.values(room.players).filter(p => !p.eliminatedThisRound && !p.pendingNextTurn);
        if (active.length === 0 && room.phase === 'clues_running') {
          endRound(code, null, 0);
        } else {
          io.to(code).emit('room_updated', roomState(room));
        }
      }
    }
    cb?.({ ok: true });
  });

  // Accidental disconnect — save player data for potential rejoin
  socket.on('disconnect', () => {
    const code = socket.data?.roomCode;
    const room = rooms[code];
    if (!room) return;

    const player = room.players[socket.id];
    if (player) {
      // Save for rejoin
      room.disconnectedPlayers[player.name] = {
        score: player.score,
        wasHost: socket.id === room.hostSocketId,
        pendingNextTurn: player.pendingNextTurn || false,
      };
    }

    // Clean up chaos answer timers
    if (room.answerTimers?.[socket.id]) {
      clearTimeout(room.answerTimers[socket.id]);
      delete room.answerTimers[socket.id];
    }
    delete room.activeAnswerers[socket.id];
    delete room.players[socket.id];

    if (socket.id === room.hostSocketId) {
      // Host disconnected — pause game, give grace period for reconnect
      room.hostSocketId = null;
      room.hostConnected = false;
      stopAllTimers(room);
      io.to(code).emit('host_disconnected', { roomState: roomState(room) });
      // After grace period, end the game if host hasn't rejoined
      room.cleanupTimer = setTimeout(() => {
        const r = rooms[code];
        if (r && !r.hostSocketId) {
          io.to(code).emit('game_ended', { reason: 'המארח לא חזר — המשחק הסתיים' });
          delete rooms[code];
        }
      }, HOST_RECONNECT_GRACE_MS);
    } else {
      // Regular player disconnected
      if (room.answeringPlayerId === socket.id && room.phase === 'player_answering') {
        handleWrongAnswer(code, socket.id);
      } else {
        const active = Object.values(room.players).filter(p => !p.eliminatedThisRound && !p.pendingNextTurn);
        if (active.length === 0 && room.phase === 'clues_running') {
          endRound(code, null, 0);
        } else {
          io.to(code).emit('room_updated', roomState(room));
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Buzzer server on port ${PORT}`);
  console.log(`Dictionary: ${DICTIONARY.length} words ready`);
});
