const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const session = require("express-session");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const db = new Database("instalk.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS friends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    friend_id INTEGER NOT NULL,
    UNIQUE(user_id, friend_id)
  );
  CREATE TABLE IF NOT EXISTS friend_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id INTEGER NOT NULL,
    to_id INTEGER NOT NULL,
    UNIQUE(from_id, to_id)
  );
`);

app.use(express.static("public"));
app.use(express.json());

const sessionMiddleware = session({
  secret: "instalk_secret_key",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
});
app.use(sessionMiddleware);

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ success: false });
  next();
}

// socketId -> username
const socketUser = new Map();
// username -> socket (latest)
const userSocket = new Map();
// username -> peer username (active chat)
const chatPairs = new Map();

function isOnline(u) { return userSocket.has(u); }

function sendTo(username, event, data) {
  const s = userSocket.get(username);
  if (s && s.connected) s.emit(event, data);
}


app.post("/register", async (req, res) => {
  const { username, password, confirm } = req.body;
  if (!username || !password || !confirm) return res.json({ success: false, message: "All fields required" });
  if (password !== confirm) return res.json({ success: false, message: "Passwords do not match" });
  if (username.length < 3) return res.json({ success: false, message: "Username too short (min 3)" });
  if (db.prepare("SELECT id FROM users WHERE username=?").get(username))
    return res.json({ success: false, message: "Username already taken" });
  const hashed = await bcrypt.hash(password, 10);
  db.prepare("INSERT INTO users (username,password) VALUES (?,?)").run(username, hashed);
  res.json({ success: true });
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE username=?").get(username);
  if (!user || !(await bcrypt.compare(password, user.password)))
    return res.json({ success: false, message: "Invalid username or password" });
  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ success: true, username: user.username });
});

app.post("/logout", (req, res) => { req.session.destroy(); res.json({ success: true }); });
app.get("/me", requireAuth, (req, res) => res.json({ success: true, username: req.session.username }));

app.post("/friends/request", requireAuth, (req, res) => {
  const { friendUsername } = req.body;
  const friend = db.prepare("SELECT id FROM users WHERE username=?").get(friendUsername);
  if (!friend) return res.json({ success: false, message: "User not found" });
  if (friend.id === req.session.userId) return res.json({ success: false, message: "Can't add yourself" });
  if (db.prepare("SELECT id FROM friends WHERE user_id=? AND friend_id=?").get(req.session.userId, friend.id))
    return res.json({ success: false, message: "Already friends" });
  if (db.prepare("SELECT id FROM friend_requests WHERE from_id=? AND to_id=?").get(req.session.userId, friend.id))
    return res.json({ success: false, message: "Request already sent" });
  db.prepare("INSERT OR IGNORE INTO friend_requests (from_id,to_id) VALUES (?,?)").run(req.session.userId, friend.id);
  sendTo(friendUsername, "friend_request", { from: req.session.username });
  res.json({ success: true });
});

app.post("/friends/accept", requireAuth, (req, res) => {
  const { fromUsername } = req.body;
  const from = db.prepare("SELECT id FROM users WHERE username=?").get(fromUsername);
  if (!from) return res.json({ success: false, message: "User not found" });
  const row = db.prepare("SELECT id FROM friend_requests WHERE from_id=? AND to_id=?").get(from.id, req.session.userId);
  if (!row) return res.json({ success: false, message: "No request found" });
  db.prepare("DELETE FROM friend_requests WHERE from_id=? AND to_id=?").run(from.id, req.session.userId);
  db.prepare("INSERT OR IGNORE INTO friends (user_id,friend_id) VALUES (?,?)").run(req.session.userId, from.id);
  db.prepare("INSERT OR IGNORE INTO friends (user_id,friend_id) VALUES (?,?)").run(from.id, req.session.userId);
  sendTo(fromUsername, "friend_request_accepted", { by: req.session.username });
  res.json({ success: true });
});

app.post("/friends/decline", requireAuth, (req, res) => {
  const { fromUsername } = req.body;
  const from = db.prepare("SELECT id FROM users WHERE username=?").get(fromUsername);
  if (from) db.prepare("DELETE FROM friend_requests WHERE from_id=? AND to_id=?").run(from.id, req.session.userId);
  res.json({ success: true });
});

app.post("/friends/remove", requireAuth, (req, res) => {
  const { friendUsername } = req.body;
  const friend = db.prepare("SELECT id FROM users WHERE username=?").get(friendUsername);
  if (!friend) return res.json({ success: false, message: "User not found" });
  db.prepare("DELETE FROM friends WHERE (user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)").run(
    req.session.userId, friend.id, friend.id, req.session.userId
  );
  res.json({ success: true });
});

app.get("/friends", requireAuth, (req, res) => {
  const friends = db.prepare(`
    SELECT u.username FROM friends f
    JOIN users u ON u.id = f.friend_id
    WHERE f.user_id = ? ORDER BY u.username
  `).all(req.session.userId).map(r => ({ username: r.username, online: isOnline(r.username) }));
  const incoming = db.prepare(`
    SELECT u.username FROM friend_requests fr
    JOIN users u ON u.id = fr.from_id WHERE fr.to_id = ?
  `).all(req.session.userId).map(r => r.username);
  const outgoing = db.prepare(`
    SELECT u.username FROM friend_requests fr
    JOIN users u ON u.id = fr.to_id WHERE fr.from_id = ?
  `).all(req.session.userId).map(r => r.username);
  res.json({ success: true, friends, incoming, outgoing });
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {

  socket.on("register", (username) => {
    const oldSocket = userSocket.get(username);
    if (oldSocket && oldSocket.id !== socket.id) {
      socketUser.delete(oldSocket.id);
    }
    socketUser.set(socket.id, username);
    userSocket.set(username, socket);
    console.log(`[+] ${username} socket=${socket.id}`);
    notifyPresence(username, true);
  });

  socket.on("get_friends_status", () => {
    const username = socketUser.get(socket.id);
    if (!username) return;
    const user = db.prepare("SELECT id FROM users WHERE username=?").get(username);
    if (!user) return;
    const rows = db.prepare(`
      SELECT u.username FROM friends f
      JOIN users u ON u.id = f.friend_id WHERE f.user_id=?
    `).all(user.id);
    const s = {};
    rows.forEach(r => { s[r.username] = isOnline(r.username); });
    socket.emit("friends_status", s);
  });

  socket.on("invite_friend", ({ friendUsername }) => {
    const username = socketUser.get(socket.id);
    if (!username) return;
    if (!isOnline(friendUsername)) {
      socket.emit("chat_status", { message: `${friendUsername} is offline` });
      return;
    }
    sendTo(friendUsername, "incoming_invite", { from: username });
    socket.emit("chat_status", { message: `Waiting for ${friendUsername}...`, waiting: true });
  });

  socket.on("accept_invite", ({ from }) => {
    const username = socketUser.get(socket.id);
    if (!username) return;
    chatPairs.set(username, from);
    chatPairs.set(from, username);
    console.log(`[PAIRED] ${username} <-> ${from}`);
    socket.emit("go_to_chat", { friendUsername: from });
    sendTo(from, "go_to_chat", { friendUsername: username });
  });

  socket.on("decline_invite", ({ from }) => {
    const username = socketUser.get(socket.id);
    if (!username) return;
    sendTo(from, "invite_declined", { by: username });
  });


  socket.on("typing_update", ({ text }) => {
    const username = socketUser.get(socket.id);
    if (!username) return;
    const peer = chatPairs.get(username);
    if (!peer) return;
    sendTo(peer, "typing_update", { text });
  });

  socket.on("end_chat", () => {
    const username = socketUser.get(socket.id);
    if (!username) return;
    const peer = chatPairs.get(username);
    if (peer) {
      sendTo(peer, "chat_ended", { by: username });
      chatPairs.delete(peer);
    }
    chatPairs.delete(username);
  });

  socket.on("disconnect", () => {
    const username = socketUser.get(socket.id);
    socketUser.delete(socket.id);
    if (!username) return;
    const currentSocket = userSocket.get(username);
    if (currentSocket && currentSocket.id === socket.id) {
      setTimeout(() => {
        const latest = userSocket.get(username);
        if (latest && latest.id === socket.id) {
          userSocket.delete(username);
          console.log(`[-] ${username} offline`);
          notifyPresence(username, false);
        }
      }, 2000);
    }
  });
});

function notifyPresence(username, online) {
  const user = db.prepare("SELECT id FROM users WHERE username=?").get(username);
  if (!user) return;
  const rows = db.prepare(`
    SELECT u.username FROM friends f JOIN users u ON u.id=f.friend_id WHERE f.user_id=?
  `).all(user.id);
  rows.forEach(r => sendTo(r.username, "friend_status_change", { username, online }));
}

// server.listen(3000, () => console.log("✅ Instalk running at http://localhost:3000"));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Instalk running on port ${PORT}`));
