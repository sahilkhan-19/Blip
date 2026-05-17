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

// rooms[roomId] = { title, createdAt, users: [{ socketId, username }], messages: [] }
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
// REST ENDPOINTS
// =====================

app.get("/", (req, res) => {
  res.send("Backend running");
});

// Get all active rooms (for initial page load before socket connects)
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
  // Use: call this right after connecting to populate the room list
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
  // Use: show room details before joining
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
  // Emits back to creator: "room-created" → { roomId, title }
  // Broadcasts to all: "rooms-updated" → updated room list
  // -------------------------------------------------------
  socket.on("create-room", (data) => {
    // Guard: already in a room
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

    rooms[roomId] = {
      title,
      createdAt: new Date().toISOString(),
      users: [{ socketId: socket.id, username }],
      messages: [],
    };

    socket.join(roomId);
    users[socket.id] = { roomId, username };

    socket.emit("room-created", { roomId, title, users: [username] });

    // Broadcast updated room list to everyone not in a room
    broadcastRoomList();

    console.log(`[ROOM CREATED] "${title}" (${roomId}) by "${username}"`);
  });

  // -------------------------------------------------------
  // JOIN ROOM
  // Payload: { roomId, username }
  // Emits back to joiner:
  //   "joined-room"   → { roomId, title, username }
  //   "chat-history"  → [message]
  // Broadcasts to room: "user-joined" → { username, users: [username] }
  // -------------------------------------------------------
  socket.on("join-room", (data) => {
    // Guard: already in a room
    if (users[socket.id]) {
      socket.emit("error", "You are already in a room");
      return;
    }

    const username = data?.username?.trim().slice(0, MAX_USERNAME_LENGTH);
    const roomId = data?.roomId;

    if (!username) {
      socket.emit("error", "Username is required");
      return;
    }

    const room = rooms[roomId];
    if (!room) {
      socket.emit("error", "Room not found");
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

    // Send history only to the new joiner
    const userList = room.users.map((u) => u.username);
    socket.emit("joined-room", { roomId, title: room.title, username, users: userList });
    socket.emit("chat-history", room.messages);
    socket.to(roomId).emit("user-joined", { username, users: userList });

    // Broadcast updated room list (user count changed)
    broadcastRoomList();

    console.log(`[JOIN] "${username}" joined room "${room.title}" (${roomId})`);
  });

  // -------------------------------------------------------
  // SEND MESSAGE
  // Payload: { text }
  // Broadcasts to room: "new-message" → { id, text, sender, timestamp }
  // -------------------------------------------------------
  socket.on("send-message", (data) => {
    const user = users[socket.id];
    if (!user) return;

    const room = rooms[user.roomId];
    if (!room) return;

    const text = data?.text?.trim();
    if (!text) return;
    if (text.length > MAX_MESSAGE_LENGTH) {
      socket.emit("error", `Message too long (max ${MAX_MESSAGE_LENGTH} chars)`);
      return;
    }

    const message = {
      id: crypto.randomUUID(),
      text,
      sender: user.username,
      timestamp: new Date().toISOString(),
    };

    // Cap history to MAX_MESSAGES
    if (room.messages.length >= MAX_MESSAGES) {
      room.messages.shift();
    }
    room.messages.push(message);

    io.to(user.roomId).emit("new-message", message);
  });

  // -------------------------------------------------------
  // TYPING START
  // Payload: none
  // Broadcasts to room (except sender): "user-typing" → { username }
  // -------------------------------------------------------
  socket.on("typing-start", () => {
    const user = users[socket.id];
    if (!user) return;
    socket.to(user.roomId).emit("user-typing", { username: user.username });
  });

  // -------------------------------------------------------
  // TYPING STOP
  // Payload: none
  // Broadcasts to room (except sender): "stop-typing" → { username }
  // -------------------------------------------------------
  socket.on("typing-stop", () => {
    const user = users[socket.id];
    if (!user) return;
    socket.to(user.roomId).emit("stop-typing", { username: user.username });
  });

  // -------------------------------------------------------
  // LEAVE ROOM
  // Payload: none
  // Allows user to leave without disconnecting (e.g. go back to room list)
  // -------------------------------------------------------
  socket.on("leave-room", () => {
    handleLeave(socket);
  });

  // -------------------------------------------------------
  // DISCONNECT
  // -------------------------------------------------------
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

  // Broadcast updated room list (room removed or user count changed)
  broadcastRoomList();
}

function broadcastRoomList() {
  const roomList = Object.entries(rooms).map(([id, room]) => ({
    roomId: id,
    title: room.title,
    userCount: room.users.length,
    createdAt: room.createdAt,
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