const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ─── Database ─────────────────────────────────────────────────────────────────
// Locally: set DATABASE_URL in a .env file or shell
// On Railway: DATABASE_URL is set automatically
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("railway")
    ? { rejectUnauthorized: false }
    : false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS friends (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      friend_id INTEGER NOT NULL,
      UNIQUE(user_id, friend_id)
    );
    CREATE TABLE IF NOT EXISTS friend_requests (
      id SERIAL PRIMARY KEY,
      from_id INTEGER NOT NULL,
      to_id INTEGER NOT NULL,
      UNIQUE(from_id, to_id)
    );
  `);
  console.log("✅ Database ready");
}
initDB();

app.use(express.static("public"));
app.use(express.json());

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || "instalk_secret_key",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
});
app.use(sessionMiddleware);

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ success: false });
  next();
}

// ─── State ────────────────────────────────────────────────────────────────────
const socketUser = new Map();
const userSocket = new Map();
const chatPairs  = new Map();

function isOnline(u) { return userSocket.has(u); }
function sendTo(username, event, data) {
  const s = userSocket.get(username);
  if (s && s.connected) s.emit(event, data);
}

// ─── REST ─────────────────────────────────────────────────────────────────────
app.post("/register", async (req, res) => {
  const { username, password, confirm } = req.body;
  if (!username || !password || !confirm) return res.json({ success: false, message: "All fields required" });
  if (password !== confirm) return res.json({ success: false, message: "Passwords do not match" });
  if (username.length < 3) return res.json({ success: false, message: "Username too short (min 3)" });
  const exists = await pool.query("SELECT id FROM users WHERE username=$1", [username]);
  if (exists.rows.length) return res.json({ success: false, message: "Username already taken" });
  const hashed = await bcrypt.hash(password, 10);
  await pool.query("INSERT INTO users (username,password) VALUES ($1,$2)", [username, hashed]);
  res.json({ success: true });
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const result = await pool.query("SELECT * FROM users WHERE username=$1", [username]);
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password)))
    return res.json({ success: false, message: "Invalid username or password" });
  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ success: true, username: user.username });
});

app.post("/logout", (req, res) => { req.session.destroy(); res.json({ success: true }); });
app.get("/me", requireAuth, (req, res) => res.json({ success: true, username: req.session.username }));

app.post("/friends/request", requireAuth, async (req, res) => {
  const { friendUsername } = req.body;
  const fr = await pool.query("SELECT id FROM users WHERE username=$1", [friendUsername]);
  const friend = fr.rows[0];
  if (!friend) return res.json({ success: false, message: "User not found" });
  if (friend.id === req.session.userId) return res.json({ success: false, message: "Can't add yourself" });
  const alreadyFriends = await pool.query("SELECT id FROM friends WHERE user_id=$1 AND friend_id=$2", [req.session.userId, friend.id]);
  if (alreadyFriends.rows.length) return res.json({ success: false, message: "Already friends" });
  const alreadySent = await pool.query("SELECT id FROM friend_requests WHERE from_id=$1 AND to_id=$2", [req.session.userId, friend.id]);
  if (alreadySent.rows.length) return res.json({ success: false, message: "Request already sent" });
  await pool.query("INSERT INTO friend_requests (from_id,to_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [req.session.userId, friend.id]);
  sendTo(friendUsername, "friend_request", { from: req.session.username });
  res.json({ success: true });
});

app.post("/friends/accept", requireAuth, async (req, res) => {
  const { fromUsername } = req.body;
  const fr = await pool.query("SELECT id FROM users WHERE username=$1", [fromUsername]);
  const from = fr.rows[0];
  if (!from) return res.json({ success: false, message: "User not found" });
  const row = await pool.query("SELECT id FROM friend_requests WHERE from_id=$1 AND to_id=$2", [from.id, req.session.userId]);
  if (!row.rows.length) return res.json({ success: false, message: "No request found" });
  await pool.query("DELETE FROM friend_requests WHERE from_id=$1 AND to_id=$2", [from.id, req.session.userId]);
  await pool.query("INSERT INTO friends (user_id,friend_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [req.session.userId, from.id]);
  await pool.query("INSERT INTO friends (user_id,friend_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [from.id, req.session.userId]);
  sendTo(fromUsername, "friend_request_accepted", { by: req.session.username });
  res.json({ success: true });
});

app.post("/friends/decline", requireAuth, async (req, res) => {
  const { fromUsername } = req.body;
  const fr = await pool.query("SELECT id FROM users WHERE username=$1", [fromUsername]);
  if (fr.rows[0]) await pool.query("DELETE FROM friend_requests WHERE from_id=$1 AND to_id=$2", [fr.rows[0].id, req.session.userId]);
  res.json({ success: true });
});

app.post("/friends/remove", requireAuth, async (req, res) => {
  const { friendUsername } = req.body;
  const fr = await pool.query("SELECT id FROM users WHERE username=$1", [friendUsername]);
  const friend = fr.rows[0];
  if (!friend) return res.json({ success: false, message: "User not found" });
  await pool.query("DELETE FROM friends WHERE (user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)", [req.session.userId, friend.id]);
  res.json({ success: true });
});

app.get("/friends", requireAuth, async (req, res) => {
  const friends = (await pool.query(`
    SELECT u.username FROM friends f
    JOIN users u ON u.id = f.friend_id
    WHERE f.user_id = $1 ORDER BY u.username
  `, [req.session.userId])).rows.map(r => ({ username: r.username, online: isOnline(r.username) }));

  const incoming = (await pool.query(`
    SELECT u.username FROM friend_requests fr
    JOIN users u ON u.id = fr.from_id WHERE fr.to_id = $1
  `, [req.session.userId])).rows.map(r => r.username);

  const outgoing = (await pool.query(`
    SELECT u.username FROM friend_requests fr
    JOIN users u ON u.id = fr.to_id WHERE fr.from_id = $1
  `, [req.session.userId])).rows.map(r => r.username);

  res.json({ success: true, friends, incoming, outgoing });
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {

  socket.on("register", (username) => {
    const oldSocket = userSocket.get(username);
    if (oldSocket && oldSocket.id !== socket.id) socketUser.delete(oldSocket.id);
    socketUser.set(socket.id, username);
    userSocket.set(username, socket);
    console.log(`[+] ${username} socket=${socket.id}`);
    notifyPresence(username, true);
  });

  socket.on("get_friends_status", async () => {
    const username = socketUser.get(socket.id);
    if (!username) return;
    const user = await pool.query("SELECT id FROM users WHERE username=$1", [username]);
    if (!user.rows[0]) return;
    const rows = await pool.query(`
      SELECT u.username FROM friends f
      JOIN users u ON u.id = f.friend_id WHERE f.user_id=$1
    `, [user.rows[0].id]);
    const s = {};
    rows.rows.forEach(r => { s[r.username] = isOnline(r.username); });
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
    if (peer) { sendTo(peer, "chat_ended", { by: username }); chatPairs.delete(peer); }
    chatPairs.delete(username);
  });

  socket.on("disconnect", () => {
    const username = socketUser.get(socket.id);
    socketUser.delete(socket.id);
    if (!username) return;
    const cur = userSocket.get(username);
    if (cur && cur.id === socket.id) {
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

async function notifyPresence(username, online) {
  const user = await pool.query("SELECT id FROM users WHERE username=$1", [username]);
  if (!user.rows[0]) return;
  const rows = await pool.query(`
    SELECT u.username FROM friends f JOIN users u ON u.id=f.friend_id WHERE f.user_id=$1
  `, [user.rows[0].id]);
  rows.rows.forEach(r => sendTo(r.username, "friend_status_change", { username, online }));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Instalk running on port ${PORT}`));
// done