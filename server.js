/* ============================================================================
   FieldSales CRM — Backend server
   Express + SQLite (file-based, no external DB service needed).
   Stores the whole CRM state (facilities, visits, quotes, orders) per user,
   so the same data shows up on every device that logs in.
   ============================================================================ */
"use strict";

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");
const path = require("path");

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret-before-deploying";
// Single-user app: set your own password via environment variable in production.
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "changeme";

const fs = require("fs");

/* ---------------- where the database lives ----------------
   On Render, files written next to server.js are WIPED on every redeploy/restart
   unless a Persistent Disk is attached. Set DATA_DIR to the disk's mount path
   (e.g. /var/data) so the database survives deploys. If DATA_DIR is set and the
   database doesn't exist there yet, we copy the old one across once. */
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_PATH = path.join(DATA_DIR, "data.db");
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const legacy = path.join(__dirname, "data.db");
  if (DATA_DIR !== __dirname && !fs.existsSync(DB_PATH) && fs.existsSync(legacy)) {
    // checkpoint the old WAL into the main file before copying, so nothing is lost
    try { const old = new Database(legacy); old.pragma("wal_checkpoint(TRUNCATE)"); old.close(); } catch (e) {}
    fs.copyFileSync(legacy, DB_PATH);
    console.log(`Copied existing database from ${legacy} to ${DB_PATH}`);
  }
} catch (e) {
  console.error("Could not prepare DATA_DIR:", e.message);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS crm_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    mimetype TEXT NOT NULL,
    size INTEGER NOT NULL,
    data BLOB NOT NULL,
    uploaded_at TEXT NOT NULL
  );
`);

/* Automatic snapshots of the whole CRM state, so a bad save or a stale device
   can never destroy data for good. Older snapshots are pruned. */
db.exec(`
  CREATE TABLE IF NOT EXISTS state_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    saved_at TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT ''
  );
`);
const SNAPSHOT_EVERY_MS = 10 * 60 * 1000; // at most one routine snapshot per 10 minutes
const SNAPSHOT_KEEP = 120;

function snapshotCurrent(reason, force) {
  const cur = db.prepare("SELECT data, updated_at FROM crm_state WHERE id = 1").get();
  if (!cur) return;
  const last = db.prepare("SELECT saved_at FROM state_history ORDER BY id DESC LIMIT 1").get();
  if (!force && last && Date.now() - new Date(last.saved_at).getTime() < SNAPSHOT_EVERY_MS) return;
  db.prepare("INSERT INTO state_history (data, updated_at, saved_at, reason) VALUES (?, ?, ?, ?)")
    .run(cur.data, cur.updated_at, new Date().toISOString(), reason || "auto");
  db.prepare(`DELETE FROM state_history WHERE id NOT IN (SELECT id FROM state_history ORDER BY id DESC LIMIT ?)`).run(SNAPSHOT_KEEP);
}

const app = express();
app.use(cors());
// 20mb covers the facility list/visits JSON blob AND base64-encoded file uploads (up to ~15MB files)
app.use(express.json({ limit: "20mb" }));

/* ---------------- auth ---------------- */
function signToken() {
  return jwt.sign({ user: "olgu" }, JWT_SECRET, { expiresIn: "30d" });
}
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Simple brute-force protection: max 8 wrong passwords per IP per 15 minutes.
const loginFails = new Map();
app.post("/api/login", (req, res) => {
  const ip = req.headers["x-forwarded-for"] ? String(req.headers["x-forwarded-for"]).split(",")[0].trim() : req.ip;
  const now = Date.now();
  const rec = loginFails.get(ip) || { count: 0, since: now };
  if (now - rec.since > 15 * 60 * 1000) { rec.count = 0; rec.since = now; }
  if (rec.count >= 8) return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
  const { password } = req.body || {};
  if (password !== AUTH_PASSWORD) {
    rec.count++; loginFails.set(ip, rec);
    return res.status(401).json({ error: "Wrong password" });
  }
  loginFails.delete(ip);
  res.json({ token: signToken() });
});

/* ---------------- state (the whole CRM data blob) ---------------- */
app.get("/api/state", requireAuth, (req, res) => {
  const row = db.prepare("SELECT data, updated_at FROM crm_state WHERE id = 1").get();
  if (!row) return res.json({ data: null, updatedAt: null });
  res.json({ data: JSON.parse(row.data), updatedAt: row.updated_at });
});

/* Saving uses a version check so one device can't silently overwrite another:
   the app sends the `updatedAt` it last loaded/saved (X-Base-Updated-At header).
   If the server copy has changed since then, we reply 409 with the current server
   copy; the app merges the two and saves again. Old app versions that don't send
   the header are still accepted (so nothing breaks mid-upgrade). */
app.put("/api/state", requireAuth, (req, res) => {
  const data = req.body;
  if (!data || !Array.isArray(data.records)) {
    return res.status(400).json({ error: "Invalid state payload" });
  }
  // Guard against an accidental empty/near-empty save wiping the customer list.
  const cur = db.prepare("SELECT data, updated_at FROM crm_state WHERE id = 1").get();
  const base = req.headers["x-base-updated-at"];
  const reason = String(req.headers["x-save-reason"] || "").slice(0, 40);
  if (cur && base && base !== cur.updated_at) {
    return res.status(409).json({ error: "conflict", data: JSON.parse(cur.data), updatedAt: cur.updated_at });
  }
  if (cur && reason !== "restore" && reason !== "reset") {
    let curCount = 0;
    try { curCount = (JSON.parse(cur.data).records || []).length; } catch (e) {}
    if (curCount > 50 && data.records.length < curCount * 0.5) {
      return res.status(422).json({ error: `Refusing to save: this would drop the customer list from ${curCount} to ${data.records.length} records. Use Restore if this is intended.` });
    }
  }
  const json = JSON.stringify(data);
  const now = new Date().toISOString();
  const write = db.transaction(() => {
    snapshotCurrent(reason || "auto", reason === "restore" || reason === "reset");
    db.prepare(`
      INSERT INTO crm_state (id, data, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `).run(json, now);
  });
  write();
  res.json({ ok: true, updatedAt: now });
});

/* ---------------- server-side backups ---------------- */
app.get("/api/backups", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT id, updated_at, saved_at, reason, length(data) AS bytes FROM state_history ORDER BY id DESC LIMIT 60").all();
  res.json({ backups: rows, dataDir: DATA_DIR === __dirname ? "app folder (NOT persistent on Render unless a disk is attached)" : DATA_DIR });
});
app.get("/api/backups/:id", requireAuth, (req, res) => {
  const row = req.params.id === "current"
    ? db.prepare("SELECT data, updated_at FROM crm_state WHERE id = 1").get()
    : db.prepare("SELECT data, updated_at FROM state_history WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Backup not found" });
  const stamp = String(row.updated_at).slice(0, 19).replace(/[:T]/g, "-");
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="fieldsales-server-backup-${stamp}.json"`);
  res.send(row.data);
});

/* ---------------- file attachments (PDF quotes/orders, photos, etc.) ----------------
   Uploaded as base64 JSON (simple, no extra libraries needed) and stored as raw
   bytes in SQLite. Quotations/orders in the main state only keep a small
   { id, filename, mimetype, size } reference, not the file itself — that keeps
   the main CRM data blob fast to save on every edit. */
app.post("/api/files", requireAuth, (req, res) => {
  const { filename, mimetype, dataBase64 } = req.body || {};
  if (!filename || !mimetype || !dataBase64) {
    return res.status(400).json({ error: "Missing filename, mimetype, or file data" });
  }
  const buffer = Buffer.from(dataBase64, "base64");
  if (buffer.length > 15 * 1024 * 1024) {
    return res.status(413).json({ error: "File too large (max 15MB)" });
  }
  const id = "f_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  db.prepare(`
    INSERT INTO files (id, filename, mimetype, size, data, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, filename, mimetype, buffer.length, buffer, new Date().toISOString());
  res.json({ id, filename, mimetype, size: buffer.length });
});

app.get("/api/files/:id", requireAuth, (req, res) => {
  const row = db.prepare("SELECT filename, mimetype, data FROM files WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "File not found" });
  res.setHeader("Content-Type", row.mimetype);
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(row.filename)}"`);
  res.send(row.data);
});

app.delete("/api/files/:id", requireAuth, (req, res) => {
  db.prepare("DELETE FROM files WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

app.get("/api/health", (req, res) => res.json({ ok: true, persistentDataDir: DATA_DIR !== __dirname }));

/* ---------------- serve the frontend ---------------- */
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`FieldSales CRM server running on port ${PORT}`);
  console.log(`Database: ${DB_PATH}`);
  if (DATA_DIR === __dirname) {
    console.log("⚠️  DATA_DIR is not set — on Render the database is lost on every redeploy unless a Persistent Disk is mounted and DATA_DIR points to it.");
  }
  if (JWT_SECRET === "change-this-secret-before-deploying") {
    console.log("⚠️  Using the default JWT_SECRET — set JWT_SECRET in your environment.");
  }
  if (AUTH_PASSWORD === "changeme") {
    console.log("⚠️  Using the default password 'changeme' — set AUTH_PASSWORD in your .env before real use.");
  }
});
