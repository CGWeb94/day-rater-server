// server/server.js
import express from "express";
import cors from "cors";
import pkg from "pg";
import { z } from "zod";

const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

// ---------- DB ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // wichtig für Supabase
});

// Tabelle anlegen, falls nicht vorhanden
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS entries (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      date DATE NOT NULL,
      score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 100),
      text TEXT DEFAULT ''
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);`);
})();

// ---------- Helpers ----------
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const entrySchema = z.object({
  score: z.number().int().min(1).max(100),
  text: z.string().max(1000).optional().default(""),
  date: isoDateSchema.optional(),
  user_id: z.string().min(1)
});

function todayLocalISODate() {
  const now = new Date();
  const offMs = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offMs).toISOString().slice(0, 10);
}

// ---------- Routes ----------

// Eintrag anlegen
app.post("/entries", async (req, res, next) => {
  try {
    const parsed = entrySchema.parse({
      score: Number(req.body.score),
      text: req.body.text ?? "",
      date: req.body.date,
      user_id: req.body.user_id
    });

    const date = parsed.date || todayLocalISODate();

    const result = await pool.query(
      `INSERT INTO entries (user_id, date, score, text) VALUES ($1, $2, $3, $4) RETURNING *`,
      [parsed.user_id, date, parsed.score, parsed.text]
    );

    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// Einträge holen (optional mit Filter)
app.get("/entries", async (req, res, next) => {
  try {
    const { from, to, limit, user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: "user_id ist erforderlich" });

    const where = ["user_id = $1"];
    const params = [user_id];

    if (from) { isoDateSchema.parse(from); where.push(`date >= $${params.length + 1}`); params.push(from); }
    if (to)   { isoDateSchema.parse(to);   where.push(`date <= $${params.length + 1}`); params.push(to);   }

    const whereSql = `WHERE ${where.join(" AND ")}`;
    const lim = Math.min(Number(limit) || 365, 1000);

    const result = await pool.query(
      `SELECT * FROM entries ${whereSql} ORDER BY date DESC, id DESC LIMIT ${lim}`,
      params
    );

    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// Stats (nur für den Nutzer)
app.get("/stats", async (req, res, next) => {
  try {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: "user_id ist erforderlich" });

    const result = await pool.query(
      `SELECT COUNT(*) as count,
              ROUND(AVG(score), 1) as avg,
              MIN(score) as min,
              MAX(score) as max
       FROM entries
       WHERE user_id = $1`,
      [user_id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// Eintrag ändern
app.put("/entries/:id", async (req, res, next) => {
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

    if (payload.score !== undefined) { z.number().int().min(1).max(100).parse(payload.score); fields.push(`score = $${fields.length + 1}`); params.push(payload.score); }
    if (payload.text !== undefined)  { z.string().max(1000).parse(payload.text); fields.push(`text = $${fields.length + 1}`); params.push(payload.text); }
    if (payload.date !== undefined)  { isoDateSchema.parse(payload.date); fields.push(`date = $${fields.length + 1}`); params.push(payload.date); }

    if (!fields.length) return res.status(400).json({ error: "No fields to update" });

    params.push(id);
    const result = await pool.query(
      `UPDATE entries SET ${fields.join(", ")} WHERE id = $${fields.length + 1} RETURNING *`,
      params
    );

    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// Eintrag löschen
app.delete("/entries/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await pool.query(`DELETE FROM entries WHERE id = $1`, [id]);
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ API läuft auf http://localhost:${PORT}`);
});
