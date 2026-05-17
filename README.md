# Blip

A real-time anonymous group chat platform. No sign-up, no email, no tracking. Users pick a username, create or join a room, and start chatting instantly. Rooms are ephemeral — they exist only while at least one person is in them.

---

## Table of Contents

1. [Features](#features)
2. [Tech Stack](#tech-stack)
3. [Project Structure](#project-structure)
4. [Architecture Overview](#architecture-overview)
5. [Data Structures](#data-structures)
6. [Socket Event Reference](#socket-event-reference)
7. [REST API Reference](#rest-api-reference)
8. [User Flow](#user-flow)
9. [Data Flow Diagrams](#data-flow-diagrams)
10. [Frontend Screens](#frontend-screens)
11. [Constraints & Limits](#constraints--limits)
12. [Getting Started](#getting-started)
13. [Environment Variables](#environment-variables)
14. [Known Limitations & Future Improvements](#known-limitations--future-improvements)

---

## Features

- **Zero sign-up** — username only, nothing stored anywhere
- **Create rooms** with a custom title, share an invite link
- **Join rooms** from a live list of active rooms or via invite link
- **Real-time messaging** via WebSockets
- **Typing indicators** — see who is typing, in real time
- **Live online count** — accurate for all participants
- **Chat history** — new joiners receive the last 200 messages
- **Ephemeral rooms** — auto-deleted when the last user leaves
- **Invite links** — shareable URLs that pre-fill the room ID on open
- **Auto-join from URL** — opening `/?room=<roomId>` skips to join flow

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js (ES Modules) |
| HTTP Server | Express.js |
| WebSocket Server | Socket.IO v4 |
| Frontend | Vanilla HTML / CSS / JavaScript |
| Fonts | IBM Plex Mono + IBM Plex Sans (Google Fonts) |
| Socket Client | Socket.IO CDN client |
| Config | dotenv |

No database. No authentication library. No frontend framework. All state lives in server memory.

---

## Project Structure

```
project/
├── server.js          # All backend logic (Express + Socket.IO)
├── .env               # Environment variables (PORT)
├── package.json
└── public/
    └── index.html     # Entire frontend (single file)
```

The frontend is served as a static file from Express. There is no build step, no bundler, no compilation.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                     CLIENT (Browser)                │
│                                                     │
│  index.html — single file, no framework             │
│  ├── 5 screens (username / home / create /          │
│  │   join / chat) managed with display:flex toggle  │
│  └── Socket.IO client — persistent WS connection    │
└──────────────────────┬──────────────────────────────┘
                       │  WebSocket (Socket.IO)
                       │  + HTTP (static files & REST)
┌──────────────────────▼──────────────────────────────┐
│                     SERVER (Node.js)                │
│                                                     │
│  Express                                            │
│  ├── GET /          → health check                  │
│  ├── GET /rooms     → room list (REST fallback)     │
│  └── static /public → serves index.html            │
│                                                     │
│  Socket.IO Server                                   │
│  ├── Manages socket connections                     │
│  ├── Handles all chat events                        │
│  └── Broadcasts to rooms using Socket.IO rooms      │
│                                                     │
│  In-memory state                                    │
│  ├── rooms{}  — all active rooms + messages         │
│  └── users{}  — socket ID → room + username mapping │
└─────────────────────────────────────────────────────┘
```

There is no external service, cache, or database. Everything resets on server restart.

---

## Data Structures

### `rooms` object (server-side)

```js
rooms = {
  "<uuid>": {
    title: "Late Night Thoughts",       // string, max 100 chars
    createdAt: "2024-01-01T00:00:00Z",  // ISO timestamp
    users: [
      {
        socketId: "abc123",             // Socket.IO socket ID
        username: "ghost_42"            // string, max 30 chars
      }
    ],
    messages: [
      {
        id: "<uuid>",                   // unique message ID
        text: "hello",                  // string, max 2000 chars
        sender: "ghost_42",             // username of sender
        timestamp: "2024-01-01T..."     // ISO timestamp
      }
    ]                                   // capped at 200 messages (FIFO)
  }
}
```

### `users` object (server-side)

```js
users = {
  "<socketId>": {
    roomId: "<uuid>",       // which room this socket is in
    username: "ghost_42"    // their chosen username
  }
}
```

This is the primary lookup table. Every socket event that needs to know "who is this?" does `users[socket.id]`.

### Message object (shared between server and client)

```js
{
  id: "550e8400-e29b-41d4-a716...",   // crypto.randomUUID()
  text: "hello world",
  sender: "ghost_42",
  timestamp: "2024-01-15T14:30:00.000Z"
}
```

---

## Socket Event Reference

### Events the CLIENT emits → server receives

| Event | Payload | Description |
|---|---|---|
| `get-rooms` | — | Request current list of active rooms |
| `get-room-info` | `{ roomId }` | Request details about a specific room |
| `create-room` | `{ username, title }` | Create a new room and join it |
| `join-room` | `{ roomId, username }` | Join an existing room |
| `send-message` | `{ text }` | Send a message to current room |
| `typing-start` | — | Notify room the user started typing |
| `typing-stop` | — | Notify room the user stopped typing |
| `leave-room` | — | Leave current room (without disconnecting) |

---

### Events the SERVER emits → client receives

#### To the requesting socket only

| Event | Payload | Trigger |
|---|---|---|
| `rooms-list` | `[{ roomId, title, userCount, createdAt }]` | Response to `get-rooms` |
| `room-info` | `{ roomId, title, userCount, users[] }` | Response to `get-room-info` |
| `room-created` | `{ roomId, title, users[] }` | Room successfully created |
| `joined-room` | `{ roomId, title, username, users[] }` | Successfully joined a room |
| `chat-history` | `[message, message, ...]` | Sent immediately after `joined-room` |
| `error` | `"error message string"` | Any validation or state error |

#### To everyone else in the room (excluding sender)

| Event | Payload | Trigger |
|---|---|---|
| `user-joined` | `{ username, users[] }` | Someone joined the room |
| `user-left` | `{ username, users[] }` | Someone left or disconnected |
| `user-typing` | `{ username }` | Someone started typing |
| `stop-typing` | `{ username }` | Someone stopped typing |

#### To everyone in the room (including sender)

| Event | Payload | Trigger |
|---|---|---|
| `new-message` | `{ id, text, sender, timestamp }` | A message was sent |

#### To ALL connected sockets (global broadcast)

| Event | Payload | Trigger |
|---|---|---|
| `rooms-updated` | `[{ roomId, title, userCount, createdAt }]` | Any room created, joined, or left |

---

## REST API Reference

These are HTTP endpoints, used independently of WebSockets.

### `GET /`

Health check.

**Response:** `200 OK` — plain text `"Backend running"`

---

### `GET /rooms`

Returns the current list of active rooms. Useful for server-side rendering or clients that want room data before establishing a WebSocket connection.

**Response:**

```json
[
  {
    "roomId": "550e8400-e29b-41d4-a716-446655440000",
    "title": "Late Night Thoughts",
    "userCount": 3,
    "createdAt": "2024-01-15T14:00:00.000Z"
  }
]
```

Returns `[]` if no rooms are active.

---

## User Flow

```
Open app
    │
    ▼
[Username Screen]
Enter any username (max 30 chars) → Continue
    │
    │  Socket connects to server here
    ▼
[Home Screen]
    ├──── Create Room ────────────────────────────────┐
    │                                                 │
    │     [Create Screen]                             │
    │     Enter room title → Create                   │
    │         │                                       │
    │         │  emit: create-room                    │
    │         │  receive: room-created                │
    │         ▼                                       │
    │     [Chat Screen] ◄─────────────────────────────┘
    │
    └──── Join Room ──────────────────────────────────┐
                                                      │
          [Join Screen]                               │
          See live room list OR paste room ID         │
          Click room card → Join                      │
              │                                       │
              │  emit: join-room                      │
              │  receive: joined-room + chat-history  │
              ▼                                       │
          [Chat Screen] ◄───────────────────────────-─┘
              │
              │  (inside chat)
              ├── Type + send messages
              ├── See typing indicators
              ├── See join/leave system messages
              ├── Copy invite link
              └── Leave → back to Home Screen
```

---

## Data Flow Diagrams

### Creating a Room

```
CLIENT                          SERVER
  │                               │
  │── emit: create-room ─────────►│
  │   { username, title }         │  1. Validate inputs
  │                               │  2. Generate roomId (UUID)
  │                               │  3. Create rooms[roomId]
  │                               │  4. Add user to rooms + users
  │                               │  5. socket.join(roomId)
  │◄── emit: room-created ────────│
  │    { roomId, title, users }   │
  │                               │──► emit: rooms-updated (to ALL)
  │                               │    updated room list
  │  [enter chat screen]          │
```

---

### Joining a Room

```
CLIENT A (joiner)               SERVER                  CLIENT B (already in room)
  │                               │                               │
  │── emit: join-room ───────────►│                               │
  │   { roomId, username }        │  1. Validate room exists      │
  │                               │  2. Check capacity (max 50)   │
  │                               │  3. Check username uniqueness │
  │                               │  4. Add to room.users + users │
  │                               │  5. socket.join(roomId)       │
  │◄── emit: joined-room ─────────│                               │
  │    { roomId, title,           │                               │
  │      username, users[] }      │                               │
  │◄── emit: chat-history ────────│                               │
  │    [last 200 messages]        │                               │
  │                               │──► emit: user-joined ────────►│
  │                               │    { username, users[] }      │
  │                               │──► emit: rooms-updated (ALL)  │
  │  [enter chat screen]          │                               │
```

---

### Sending a Message

```
CLIENT A (sender)               SERVER                  ROOM (all clients)
  │                               │                          │
  │── emit: send-message ────────►│                          │
  │   { text }                    │  1. Look up user by      │
  │                               │     socket.id            │
  │                               │  2. Validate text        │
  │                               │  3. Build message obj    │
  │                               │  4. Push to room history │
  │                               │     (shift if > 200)     │
  │                               │──► emit: new-message ───►│
  │                               │    { id, text,           │
  │                               │      sender, timestamp } │
  │  [message appears on right]   │       [appears on left]  │
```

---

### Typing Indicator

```
CLIENT A                        SERVER                  OTHER CLIENTS IN ROOM
  │                               │                          │
  │  (user starts typing)         │                          │
  │── emit: typing-start ────────►│                          │
  │                               │──► emit: user-typing ───►│
  │                               │    { username }          │  [show "A is typing..."]
  │                               │                          │
  │  (2s no input, or sends msg)  │                          │
  │── emit: typing-stop ─────────►│                          │
  │                               │──► emit: stop-typing ───►│
  │                               │    { username }          │  [hide indicator]
```

---

### Disconnecting / Leaving

```
CLIENT                          SERVER                  ROOM MEMBERS
  │                               │                          │
  │── emit: leave-room ──────────►│  (or browser closes)     │
  │   (or TCP disconnect)         │                          │
  │                               │  1. Find user by         │
  │                               │     socket.id            │
  │                               │  2. Remove from          │
  │                               │     room.users           │
  │                               │  3. If room empty:       │
  │                               │     delete rooms[roomId] │
  │                               │  4. delete users[id]     │
  │                               │  5. socket.leave(roomId) │
  │                               │──► emit: user-left ─────►│
  │                               │    { username, users[] } │
  │                               │──► emit: rooms-updated   │
  │                               │    (ALL sockets)         │
```

---

## Frontend Screens

The entire frontend is a single `index.html` file with 5 screens. Screen switching is done by toggling a CSS class `active` (which sets `display: flex`) on the target screen div and removing it from all others.

### Screen 1 — Username (`#username-screen`)

- Single text input for username (max 30 chars)
- On submit: stores username in `myUsername` variable, initialises Socket.IO connection, moves to Screen 2
- If URL contains `?room=<id>`, modifies the submit handler to auto-navigate to the join screen with the room ID pre-filled

### Screen 2 — Home (`#action-screen`)

- Two buttons: **Create Room** and **Join Room**
- Displays welcome message with chosen username

### Screen 3 — Create Room (`#create-screen`)

- Single text input for room title (max 100 chars)
- On submit: emits `create-room` → waits for `room-created` → enters chat

### Screen 4 — Join Room (`#join-screen`)

- Text input to paste a room ID directly
- Live-rendered list of active rooms (cards showing title + user count)
- Clicking a card selects it and populates the input
- Emits `get-rooms` on screen open to refresh list
- `rooms-updated` socket event also updates the list in real time while on this screen
- On join: emits `join-room` → waits for `joined-room` + `chat-history` → enters chat

### Screen 5 — Chat (`#chat-screen`)

| Element | Description |
|---|---|
| Header | Room title, live online count, username badge, Invite button, Leave button |
| Chat body | Scrollable message list. Own messages right-aligned (yellow bubble), others left-aligned. System messages (join/leave) centred in muted text. |
| Typing indicator | Shows `"X is typing…"` or `"X and Y are typing…"` below chat body |
| Footer | Text input + send button. Enter key sends. Typing events fire automatically. |

**Typing debounce logic:**

```
oninput → emit typing-start (if not already typing)
        → set/reset 2s timer
        → on timer expire: emit typing-stop
        → on message send: emit typing-stop + clear timer
```

**Message rendering:**

```js
isMine  = msg.sender === myUsername
class   = isMine ? "msg mine" : "msg theirs"
bubble  = isMine ? yellow background : dark surface with border
sender  = shown above bubble for others only (not for own messages)
time    = shown below bubble, formatted HH:MM
```

All user-supplied text is HTML-escaped before rendering to prevent XSS.

---

## Constraints & Limits

| Constraint | Value | Enforced In |
|---|---|---|
| Max users per room | 50 | Server (`join-room`) |
| Max message length | 2000 chars | Server (`send-message`) |
| Max message history | 200 messages | Server (FIFO `shift()`) |
| Max username length | 30 chars | Server (`.slice()`) + HTML `maxlength` |
| Max room title length | 100 chars | Server (`.slice()`) + HTML `maxlength` |
| Username uniqueness | Per-room only | Server (`join-room`) |
| Rooms per socket | 1 | Server (guard in `create-room` + `join-room`) |

---

## Getting Started

### Prerequisites

- Node.js v18 or higher (for native `crypto.randomUUID()` and ES module support)

### Installation

```bash
# 1. Clone the repo
git clone <your-repo-url>
cd blip

# 2. Install dependencies
npm install

# 3. Create .env file
echo "PORT=3000" > .env

# 4. Start the server
node server.js
```

Open `http://localhost:3000` in your browser.

### package.json (minimum required)

```json
{
  "name": "blip",
  "version": "1.0.0",
  "type": "module",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "cors": "^2.8.5",
    "dotenv": "^16.0.0",
    "express": "^4.18.0",
    "socket.io": "^4.7.5"
  },
  "devDependencies": {
    "nodemon": "^3.0.0"
  }
}
```

### File placement

```
project/
├── server.js
├── .env
├── package.json
└── public/
    └── index.html   ← place the frontend here
```

Express serves everything in `public/` as static files. `index.html` is served at the root `/` path automatically.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the HTTP + WebSocket server listens on |

---

## Known Limitations & Future Improvements

### Current limitations

**No persistence** — all rooms and messages are lost on server restart. This is by design for anonymity but means no history across sessions.

**No authentication** — any client can emit any event with any username. There is no way to verify that a `send-message` event actually came from the user who joined with that username, beyond the socket session.

**Single server only** — all state is in one Node.js process. Horizontal scaling (multiple servers) would require a shared state layer (e.g. Redis + Socket.IO Redis adapter).

**No rate limiting** — a single socket can emit `send-message` in a tight loop and flood a room. A token bucket or message cooldown per socket should be added before any public deployment.

**In-memory only** — the server will run out of memory if enough rooms and messages accumulate. Practical for small deployments; needs Redis or a database for anything larger.

**No moderation** — no word filtering, no ability to kick users, no room passwords or privacy settings.

### Suggested improvements

- **Rate limiting on `send-message`** — track last message timestamp per socket, reject if too frequent
- **Redis adapter** — replace in-memory `rooms`/`users` with Redis for multi-instance support and restart persistence
- **Room passwords** — optional PIN on room creation for private rooms
- **Message reactions** — emoji reactions on messages
- **File/image sharing** — base64 upload or presigned S3 URLs
- **Room expiry** — auto-delete inactive rooms after N minutes even if users are still connected
- **Username reservation** — lock username to socket ID for the session so the same person can't be impersonated in the same room
- **HTTPS / WSS** — terminate TLS at the reverse proxy (nginx/Caddy) in front of the Node server for production
