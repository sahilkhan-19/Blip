import express from "express";
import http from "http";
import crypto from "crypto";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.static("public"));

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// rooms[roomId] = { title, createdAt, pin, users: [{ socketId, username }], messages: [] }
const rooms = {};

// users[socketId] = { roomId, username }
const users = {};

// =====================
// CONSTANTS
// =====================
const MAX_USERS_PER_ROOM = 50;
const MAX_MESSAGES = 200;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_USERNAME_LENGTH = 30;
const MAX_TITLE_LENGTH = 100;

// =====================
// HELPERS
// =====================

function generatePin() {
  // 4-digit numeric PIN: 1000–9999
  return String(Math.floor(1000 + Math.random() * 9000));
}

// =====================
// REST ENDPOINTS
// =====================

app.get("/", (req, res) => {
  res.send("Backend running");
});

// Get all active rooms — note: PIN is intentionally excluded from this list
app.get("/rooms", (req, res) => {
  const roomList = Object.entries(rooms).map(([id, room]) => ({
    roomId: id,
    title: room.title,
    userCount: room.users.length,
    createdAt: room.createdAt,
  }));
  res.json(roomList);
});

// =====================
// SOCKET EVENTS
// =====================

io.on("connection", (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // -------------------------------------------------------
  // GET ROOMS
  // Payload: none
  // Emits back: "rooms-list" → [{ roomId, title, userCount, createdAt }]
  // PIN is never sent in room listings for security
  // -------------------------------------------------------
  socket.on("get-rooms", () => {
    const roomList = Object.entries(rooms).map(([id, room]) => ({
      roomId: id,
      title: room.title,
      userCount: room.users.length,
      createdAt: room.createdAt,
    }));
    socket.emit("rooms-list", roomList);
  });

  // -------------------------------------------------------
  // GET ROOM INFO
  // Payload: { roomId }
  // Emits back: "room-info" → { roomId, title, userCount, users: [username] }
  // PIN is not included here either
  // -------------------------------------------------------
  socket.on("get-room-info", (data) => {
    const room = rooms[data?.roomId];
    if (!room) {
      socket.emit("error", "Room not found");
      return;
    }
    socket.emit("room-info", {
      roomId: data.roomId,
      title: room.title,
      userCount: room.users.length,
      users: room.users.map((u) => u.username),
    });
  });

  // -------------------------------------------------------
  // CREATE ROOM
  // Payload: { username, title }
  // Emits back to creator: "room-created" → { roomId, title, pin, users }
  //   ↑ PIN is only sent to the creator, never broadcast
  // Broadcasts to all: "rooms-updated" → updated room list (no PIN)
  // -------------------------------------------------------
  socket.on("create-room", (data) => {
    if (users[socket.id]) {
      socket.emit("error", "You are already in a room");
      return;
    }

    const username = data?.username?.trim().slice(0, MAX_USERNAME_LENGTH);
    const title = data?.title?.trim().slice(0, MAX_TITLE_LENGTH);

    if (!username) {
      socket.emit("error", "Username is required");
      return;
    }
    if (!title) {
      socket.emit("error", "Room title is required");
      return;
    }

    const roomId = crypto.randomUUID();
    const pin = generatePin();

    rooms[roomId] = {
      title,
      pin,
      createdAt: new Date().toISOString(),
      users: [{ socketId: socket.id, username }],
      messages: [],
    };

    socket.join(roomId);
    users[socket.id] = { roomId, username };

    // Send PIN only to the creator
    socket.emit("room-created", { roomId, title, pin, users: [username] });

    broadcastRoomList();

    console.log(
      `[ROOM CREATED] "${title}" (${roomId}) by "${username}" | PIN: ${pin}`,
    );
  });

  // -------------------------------------------------------
  // JOIN ROOM
  // Payload: { roomId, username, pin }
  // Validates PIN before allowing entry.
  // Emits back to joiner:
  //   "joined-room"   → { roomId, title, username, users }
  //   "chat-history"  → [message]
  // Broadcasts to room: "user-joined" → { username, users }
  // -------------------------------------------------------
  socket.on("join-room", (data) => {
    if (users[socket.id]) {
      socket.emit("error", "You are already in a room");
      return;
    }

    const username = data?.username?.trim().slice(0, MAX_USERNAME_LENGTH);
    const roomId = data?.roomId;
    const pin = data?.pin?.trim();

    if (!username) {
      socket.emit("error", "Username is required");
      return;
    }

    const room = rooms[roomId];
    if (!room) {
      socket.emit("error", "Room not found");
      return;
    }

    // PIN validation
    if (!pin) {
      socket.emit("error", "PIN is required to join this room");
      return;
    }
    if (pin !== room.pin) {
      socket.emit("error", "Incorrect PIN. Ask the room creator for the PIN.");
      return;
    }

    if (room.users.length >= MAX_USERS_PER_ROOM) {
      socket.emit("error", "Room is full");
      return;
    }

    const duplicate = room.users.find((u) => u.username === username);
    if (duplicate) {
      socket.emit("error", "Username already taken in this room. Try another.");
      return;
    }

    room.users.push({ socketId: socket.id, username });
    socket.join(roomId);
    users[socket.id] = { roomId, username };

    const userList = room.users.map((u) => u.username);
    socket.emit("joined-room", {
      roomId,
      title: room.title,
      username,
      users: userList,
    });
    socket.emit("chat-history", room.messages);
    socket.to(roomId).emit("user-joined", { username, users: userList });

    broadcastRoomList();

    console.log(`[JOIN] "${username}" joined room "${room.title}" (${roomId})`);
  });

  // -------------------------------------------------------
  // SEND MESSAGE
  // -------------------------------------------------------
  socket.on("send-message", (data) => {
    const user = users[socket.id];
    if (!user) return;

    const room = rooms[user.roomId];
    if (!room) return;

    const text = data?.text?.trim();
    if (!text) return;
    if (text.length > MAX_MESSAGE_LENGTH) {
      socket.emit(
        "error",
        `Message too long (max ${MAX_MESSAGE_LENGTH} chars)`,
      );
      return;
    }

    const message = {
      id: crypto.randomUUID(),
      text,
      sender: user.username,
      timestamp: new Date().toISOString(),
    };

    if (room.messages.length >= MAX_MESSAGES) {
      room.messages.shift();
    }
    room.messages.push(message);

    io.to(user.roomId).emit("new-message", message);
  });

  // -------------------------------------------------------
  // TYPING START / STOP
  // -------------------------------------------------------
  socket.on("typing-start", () => {
    const user = users[socket.id];
    if (!user) return;
    socket.to(user.roomId).emit("user-typing", { username: user.username });
  });

  socket.on("typing-stop", () => {
    const user = users[socket.id];
    if (!user) return;
    socket.to(user.roomId).emit("stop-typing", { username: user.username });
  });

  // -------------------------------------------------------
  // LEAVE ROOM / DISCONNECT
  // -------------------------------------------------------
  socket.on("leave-room", () => {
    handleLeave(socket);
  });

  socket.on("disconnect", () => {
    handleLeave(socket);
    console.log(`[-] Disconnected: ${socket.id}`);
  });
});

// =====================
// HELPERS
// =====================

function handleLeave(socket) {
  const user = users[socket.id];
  if (!user) return;

  const { roomId, username } = user;
  const room = rooms[roomId];

  if (room) {
    room.users = room.users.filter((u) => u.socketId !== socket.id);

    if (room.users.length === 0) {
      delete rooms[roomId];
      console.log(`[ROOM DESTROYED] ${roomId}`);
    } else {
      const userList = room.users.map((u) => u.username);
      socket.to(roomId).emit("user-left", { username, users: userList });
    }
  }

  socket.leave(roomId);
  delete users[socket.id];

  broadcastRoomList();
}

function broadcastRoomList() {
  const roomList = Object.entries(rooms).map(([id, room]) => ({
    roomId: id,
    title: room.title,
    userCount: room.users.length,
    createdAt: room.createdAt,
    // PIN intentionally excluded
  }));
  io.emit("rooms-updated", roomList);
}

// =====================
// START SERVER
// =====================

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
