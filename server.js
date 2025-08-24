// server/server.js
import express from "express";
import cors from "cors";
import Database from "better-sqlite3";
import { z } from "zod";

const app = express();
app.use(cors());
app.use(express.json());

// ---------- DB ----------
const db = new Database("days.db");
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

db.prepare(`
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,                         -- YYYY-MM-DD (lokales Datum)
    score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 100),
    text TEXT DEFAULT ''
  )
`).run();

db.prepare(`CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date)`).run();

// ---------- Helpers ----------
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const entrySchema = z.object({
  score: z.number().int().min(1).max(100),
  text: z.string().max(1000).optional().default(""),
  date: isoDateSchema.optional() // falls leer -> nehmen wir heutiges lokales Datum
});

// lokales YYYY-MM-DD (unabhängig von Zeitzone robust erzeugen)
function todayLocalISODate() {
  const now = new Date();
  const offMs = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offMs).toISOString().slice(0, 10);
}

// ---------- Routes ----------

// Eintrag anlegen
app.post("/entries", (req, res, next) => {
  try {
    // Zahlen aus JSON kommen evtl. als String -> casten
    const parsed = entrySchema.parse({
      score: Number(req.body.score),
      text: req.body.text ?? "",
      date: req.body.date
    });

    const date = parsed.date || todayLocalISODate();

    const stmt = db.prepare(
      `INSERT INTO entries (date, score, text) VALUES (?, ?, ?)`
    );
    const info = stmt.run(date, parsed.score, parsed.text);

    const row = db.prepare(`SELECT * FROM entries WHERE id = ?`).get(info.lastInsertRowid);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// Einträge holen (optional mit Filter ?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=100)
app.get("/entries", (req, res, next) => {
  try {
    const { from, to, limit } = req.query;

    const where = [];
    const params = [];

    if (from) { isoDateSchema.parse(from); where.push("date >= ?"); params.push(from); }
    if (to)   { isoDateSchema.parse(to);   where.push("date <= ?"); params.push(to);   }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const lim = Math.min(Number(limit) || 365, 1000); // Safety-Limit

    const rows = db
      .prepare(`SELECT * FROM entries ${whereSql} ORDER BY date DESC, id DESC LIMIT ${lim}`)
      .all(...params);

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Stats (Durchschnitt, Anzahl, min/max)
app.get("/stats", (_req, res, next) => {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) as count,
             ROUND(AVG(score), 1) as avg,
             MIN(score) as min,
             MAX(score) as max
      FROM entries
    `).get();
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// Eintrag ändern (optional, nice to have)
app.put("/entries/:id", (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new Error("Invalid id");

    const payload = {
      score: req.body.score !== undefined ? Number(req.body.score) : undefined,
      text: req.body.text,
      date: req.body.date
    };

    const fields = [];
    const params = [];
    if (payload.score !== undefined) { z.number().int().min(1).max(100).parse(payload.score); fields.push("score = ?"); params.push(payload.score); }
    if (payload.text !== undefined)  { z.string().max(1000).parse(payload.text); fields.push("text = ?"); params.push(payload.text); }
    if (payload.date !== undefined)  { isoDateSchema.parse(payload.date); fields.push("date = ?"); params.push(payload.date); }

    if (!fields.length) return res.status(400).json({ error: "No fields to update" });

    params.push(id);
    db.prepare(`UPDATE entries SET ${fields.join(", ")} WHERE id = ?`).run(...params);

    const row = db.prepare(`SELECT * FROM entries WHERE id = ?`).get(id);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// Eintrag löschen (optional)
app.delete("/entries/:id", (req, res, next) => {
  try {
    const id = Number(req.params.id);
    db.prepare(`DELETE FROM entries WHERE id = ?`).run(id);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Error-Handler
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(400).json({ error: err.message || "Bad Request" });
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`✅ API läuft auf http://localhost:${PORT}`);
});
