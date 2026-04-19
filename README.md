# Instalk — Setup Guide

## Prerequisites
- Node.js v18+ (https://nodejs.org)

## Project Structure
```
instalk/
├── server.js          ← Backend (Express + Socket.IO + SQLite)
├── package.json
├── instalk.db         ← Auto-created on first run (SQLite)
└── public/
    ├── index.html     ← Redirects to login
    ├── login.html
    ├── register.html
    ├── friends.html
    ├── main.html
    ├── style_login.css
    ├── style_friends.css
    └── style_main.css
```

## Setup Steps

### 1. Install dependencies
```bash
cd instalk
npm install
```

### 2. Start the server
```bash
npm start
```
Or for auto-reload during development:
```bash
npm run dev
```

### 3. Open in browser
```
http://localhost:3000
```

---

## How It Works

### Auth
- Passwords are **hashed with bcrypt** (not stored as plaintext)
- Sessions are stored server-side with **express-session**
- No more localStorage for auth — the session cookie handles everything

### Friends
- Add a friend by username — friendship is **mutual** (both see each other)
- **Green dot** = online, **Red dot** = offline
- Status updates in real-time via Socket.IO

### Chat Flow
1. Go to Friends page → select a friend → click **Connect**
2. If they're online, both of you are taken to the chat page
3. **Enter** sends your message; **Shift+Enter** adds a newline
4. Click **End** to close the session for both users

### Realtime (Socket.IO)
- Presence updates fire instantly when someone connects/disconnects
- Messages are relayed server-side — no data stored, ephemeral only

---

## Testing Locally (2 users)

Open two different browsers (e.g. Chrome + Firefox, or Chrome + Incognito):
1. Register two accounts
2. Add each other as friends
3. On one browser, select the friend and click **Connect**
4. Both windows jump to the chat page automatically

---

## Production Notes (if deploying)

- Change the session secret in server.js:
  ```js
  secret: "your_long_random_secret_here"
  ```
- Use HTTPS (required for secure cookies)
- Consider `connect-sqlite3` or `better-sqlite3-session-store` for persistent sessions
# instalk
