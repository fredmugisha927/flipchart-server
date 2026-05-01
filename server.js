/*
 ╔══════════════════════════════════════════════════════════════╗
 ║         KIGALI FLIPCHART — REAL BACKEND SERVER              ║
 ║         File: server.js                                      ║
 ║         This makes your website 100% real:                   ║
 ║         ✅ Real video matching between strangers             ║
 ║         ✅ Real user count (live)                            ║
 ║         ✅ Real admin stats                                  ║
 ║         ✅ Real WebRTC peer connections                      ║
 ╚══════════════════════════════════════════════════════════════╝
*/

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const path       = require('path');

// ─────────────────────────────────────────
//  APP SETUP
// ─────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: {
    origin: '*',          // allows your Netlify site to connect
    methods: ['GET','POST']
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────
//  IN-MEMORY STATE
//  (works without a database for real-time)
// ─────────────────────────────────────────
const waitingUsers  = [];   // users waiting to be matched
const activePairs   = {};   // roomId → { user1, user2 }
const onlineUsers   = {};   // socketId → { email, name, joinedAt }
const adminStats    = {
  totalConnections : 0,
  totalSessions    : 0,
  peakOnline       : 0,
};

// ─────────────────────────────────────────
//  HELPER — generate a room ID
// ─────────────────────────────────────────
function makeRoomId(a, b) {
  return [a, b].sort().join('__');
}

// ─────────────────────────────────────────
//  HELPER — broadcast live stats to admins
// ─────────────────────────────────────────
function broadcastStats() {
  const onlineCount = Object.keys(onlineUsers).length;
  if (onlineCount > adminStats.peakOnline) {
    adminStats.peakOnline = onlineCount;
  }
  io.to('admin-room').emit('live-stats', {
    online         : onlineCount,
    waiting        : waitingUsers.length,
    activeSessions : Object.keys(activePairs).length,
    totalSessions  : adminStats.totalSessions,
    peakOnline     : adminStats.peakOnline,
  });
}

// ─────────────────────────────────────────
//  SOCKET.IO — MAIN CONNECTION HANDLER
// ─────────────────────────────────────────
io.on('connection', (socket) => {

  console.log(`[+] Connected: ${socket.id}`);

  // ── 1. User registers themselves ──────────────────────────
  socket.on('register', ({ email, name }) => {
    onlineUsers[socket.id] = {
      email    : email || 'anonymous',
      name     : name  || 'User',
      joinedAt : new Date().toISOString(),
      socketId : socket.id,
    };
    // Send live online count to everyone
    io.emit('online-count', Object.keys(onlineUsers).length);
    broadcastStats();
    console.log(`[register] ${name} (${email})`);
  });

  // ── 2. Admin joins the admin room ─────────────────────────
  socket.on('join-admin', () => {
    socket.join('admin-room');
    broadcastStats();
    // Send full user list to admin
    socket.emit('user-list', Object.values(onlineUsers));
  });

  // ── 3. User wants to find a stranger ──────────────────────
  socket.on('find-match', () => {
    // Remove from any existing pair first
    leaveCurrentPair(socket);

    if (waitingUsers.length > 0) {
      // ── Someone is already waiting — match them! ──
      const partnerId  = waitingUsers.shift();
      const partnerSock = io.sockets.sockets.get(partnerId);

      if (!partnerSock) {
        // Partner disconnected — try again
        socket.emit('find-match');
        return;
      }

      const roomId = makeRoomId(socket.id, partnerId);
      activePairs[roomId] = { user1: socket.id, user2: partnerId };
      adminStats.totalSessions++;

      socket.join(roomId);
      partnerSock.join(roomId);

      // Tell both users they are matched
      // The one who just connected is the "caller" (initiates WebRTC offer)
      socket.emit('matched', { roomId, role: 'caller' });
      partnerSock.emit('matched', { roomId, role: 'answerer' });

      adminStats.totalConnections++;
      broadcastStats();
      console.log(`[match] ${socket.id} ↔ ${partnerId} in room ${roomId}`);

    } else {
      // ── Nobody waiting — add this user to the queue ──
      if (!waitingUsers.includes(socket.id)) {
        waitingUsers.push(socket.id);
      }
      socket.emit('waiting');
      console.log(`[waiting] ${socket.id}`);
    }
  });

  // ── 4. WebRTC Signaling — pass messages between peers ─────
  //    These 3 events are the core of WebRTC peer connection

  // Caller sends offer → forward to answerer
  socket.on('webrtc-offer', ({ roomId, offer }) => {
    socket.to(roomId).emit('webrtc-offer', { offer, from: socket.id });
  });

  // Answerer sends answer → forward to caller
  socket.on('webrtc-answer', ({ roomId, answer }) => {
    socket.to(roomId).emit('webrtc-answer', { answer, from: socket.id });
  });

  // Both sides exchange ICE candidates
  socket.on('webrtc-ice', ({ roomId, candidate }) => {
    socket.to(roomId).emit('webrtc-ice', { candidate, from: socket.id });
  });

  // ── 5. Text chat message ──────────────────────────────────
  socket.on('chat-message', ({ roomId, message }) => {
    socket.to(roomId).emit('chat-message', {
      message,
      from: onlineUsers[socket.id]?.name || 'Stranger',
    });
  });

  // ── 6. User clicks "Next" — skip to new person ───────────
  socket.on('skip', () => {
    const roomId = findRoomOf(socket.id);
    if (roomId) {
      const pair = activePairs[roomId];
      const otherId = pair.user1 === socket.id ? pair.user2 : pair.user1;
      const otherSock = io.sockets.sockets.get(otherId);
      // Tell the other person the stranger left
      if (otherSock) {
        otherSock.emit('stranger-left');
        // Put them back in the queue
        waitingUsers.push(otherId);
        otherSock.emit('waiting');
      }
      // Clean up the room
      delete activePairs[roomId];
      socket.leave(roomId);
      if (otherSock) otherSock.leave(roomId);
    }
    // Find this user a new match
    socket.emit('find-match');
    broadcastStats();
  });

  // ── 7. User reports a stranger ────────────────────────────
  socket.on('report-user', ({ reportedId, reason }) => {
    console.log(`[report] ${socket.id} reported ${reportedId}: ${reason}`);
    // Forward report to admin dashboard
    io.to('admin-room').emit('new-report', {
      reporter   : onlineUsers[socket.id]?.email || socket.id,
      reported   : onlineUsers[reportedId]?.email || reportedId,
      reason,
      timestamp  : new Date().toISOString(),
    });
  });

  // ── 8. User disconnects ───────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[-] Disconnected: ${socket.id}`);

    // Remove from waiting queue
    const idx = waitingUsers.indexOf(socket.id);
    if (idx !== -1) waitingUsers.splice(idx, 1);

    // Notify their partner if in active session
    leaveCurrentPair(socket);

    // Remove from online users
    delete onlineUsers[socket.id];

    // Update everyone's online count
    io.emit('online-count', Object.keys(onlineUsers).length);
    broadcastStats();
  });

  // ── Helper: find which room this socket is in ─────────────
  function findRoomOf(socketId) {
    for (const [roomId, pair] of Object.entries(activePairs)) {
      if (pair.user1 === socketId || pair.user2 === socketId) {
        return roomId;
      }
    }
    return null;
  }

  // ── Helper: cleanly leave current pairing ────────────────
  function leaveCurrentPair(sock) {
    const roomId = findRoomOf(sock.id);
    if (!roomId) return;
    const pair = activePairs[roomId];
    const otherId = pair.user1 === sock.id ? pair.user2 : pair.user1;
    const otherSock = io.sockets.sockets.get(otherId);
    if (otherSock) {
      otherSock.emit('stranger-left');
      otherSock.leave(roomId);
      // Re-queue the other person
      if (!waitingUsers.includes(otherId)) {
        waitingUsers.push(otherId);
        otherSock.emit('waiting');
      }
    }
    sock.leave(roomId);
    delete activePairs[roomId];
    broadcastStats();
  }

});

// ─────────────────────────────────────────
//  REST API — for admin dashboard
// ─────────────────────────────────────────

// GET /api/stats — live platform stats
app.get('/api/stats', (req, res) => {
  res.json({
    online         : Object.keys(onlineUsers).length,
    waiting        : waitingUsers.length,
    activeSessions : Object.keys(activePairs).length,
    totalSessions  : adminStats.totalSessions,
    totalConnections: adminStats.totalConnections,
    peakOnline     : adminStats.peakOnline,
  });
});

// GET /api/users — list of online users (for admin)
app.get('/api/users', (req, res) => {
  res.json(Object.values(onlineUsers));
});

// POST /api/ban — ban a user by socket ID or email
app.post('/api/ban', (req, res) => {
  const { email } = req.body;
  // Find and disconnect the user
  for (const [sockId, user] of Object.entries(onlineUsers)) {
    if (user.email === email) {
      const sock = io.sockets.sockets.get(sockId);
      if (sock) {
        sock.emit('banned', { reason: 'You have been banned by admin.' });
        sock.disconnect(true);
      }
    }
  }
  console.log(`[ban] ${email} banned by admin`);
  res.json({ success: true, message: `${email} has been banned.` });
});

// ─────────────────────────────────────────
//  START SERVER
// ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║   KIGALI FLIPCHART SERVER RUNNING    ║');
  console.log(`║   Port: ${PORT}                          ║`);
  console.log('║   Status: LIVE ✅                    ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');
});
