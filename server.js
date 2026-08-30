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

const db = new Database(path.join(__dirname, "data.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS crm_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" })); // the facility list + visits can be a fairly large JSON blob

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

app.post("/api/login", (req, res) => {
  const { password } = req.body || {};
  if (password !== AUTH_PASSWORD) {
    return res.status(401).json({ error: "Wrong password" });
  }
  res.json({ token: signToken() });
});

/* ---------------- state (the whole CRM data blob) ---------------- */
app.get("/api/state", requireAuth, (req, res) => {
  const row = db.prepare("SELECT data, updated_at FROM crm_state WHERE id = 1").get();
  if (!row) return res.json({ data: null, updatedAt: null });
  res.json({ data: JSON.parse(row.data), updatedAt: row.updated_at });
});

app.put("/api/state", requireAuth, (req, res) => {
  const data = req.body;
  if (!data || !Array.isArray(data.records)) {
    return res.status(400).json({ error: "Invalid state payload" });
  }
  const json = JSON.stringify(data);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO crm_state (id, data, updated_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(json, now);
  res.json({ ok: true, updatedAt: now });
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

/* ---------------- serve the frontend ---------------- */
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`FieldSales CRM server running on port ${PORT}`);
  if (AUTH_PASSWORD === "changeme") {
    console.log("⚠️  Using the default password 'changeme' — set AUTH_PASSWORD in your .env before real use.");
  }
});
