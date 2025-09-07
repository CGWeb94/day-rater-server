import express from "express";
import cors from "cors";
import pkg from "pg";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

// ---------- Supabase Client (für Auth) ----------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------- DB ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Tabelle anlegen, falls nicht vorhanden
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS entries (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      date DATE NOT NULL,
      score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 100),
      text TEXT DEFAULT '',
      iv TEXT,
      badge TEXT,
      color TEXT
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);`);
})();

// ---------- Helpers ----------
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const entrySchema = z.object({
  score: z.number().int().min(1).max(100),
  text: z.string().max(1000).optional().default(""),
  iv: z.string().max(32).optional(),  // Base64 IV max Länge erhöht
  badge: z.string().max(50).optional(),
  color: z.string().optional(),
  date: isoDateSchema.optional()
});

function todayLocalISODate() {
  const now = new Date();
  const offMs = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offMs).toISOString().slice(0, 10);
}

// Score -> Farbe (0=rot, 50=gelb, 100=grün)
function scoreToColor(score) {
  score = Math.max(0, Math.min(100, score));
  let r, g, b = 0;
  if (score <= 50) {
    const t = score / 50;
    r = 255;
    g = Math.round(255 * t);
  } else {
    const t = (score - 50) / 50;
    r = Math.round(255 * (1 - t));
    g = 255;
  }
  return `rgb(${r},${g},${b})`;
}

// Middleware: JWT prüfen und user_id setzen
async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "Authorization Header fehlt" });

    const token = authHeader.split(" ")[1];
    if (!token) return res.status(401).json({ error: "Token fehlt" });

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: "Ungültiger Token" });

    req.user_id = user.id;
    next();
  } catch (err) {
    console.error(err);
    res.status(401).json({ error: "Auth Fehler" });
  }
}

// ---------- Routes ----------

// Eintrag anlegen
app.post("/entries", authenticate, async (req, res, next) => {
  try {
    const parsed = entrySchema.parse({
      score: Number(req.body.score),
      text: req.body.text,
      iv: req.body.iv,
      badge: req.body.badge,
      color: req.body.color,
      date: req.body.date
    });

    const date = parsed.date || todayLocalISODate();
    const color = parsed.color || scoreToColor(parsed.score);

    const result = await pool.query(
      `INSERT INTO entries (user_id, date, score, text, iv, badge, color)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.user_id, date, parsed.score, parsed.text, parsed.iv || null, parsed.badge || null, color]
    );

    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// Einträge holen (optional mit Filter)
app.get("/entries", authenticate, async (req, res, next) => {
  try {
    const { from, to, limit } = req.query;
    const where = ["user_id = $1"];
    const params = [req.user_id];

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

// Stats
app.get("/stats", authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) as count,
              ROUND(AVG(score), 1) as avg,
              MIN(score) as min,
              MAX(score) as max
       FROM entries
       WHERE user_id = $1`,
      [req.user_id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// Eintrag ändern
app.put("/entries/:id", authenticate, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new Error("Invalid id");

    const payload = {
      score: req.body.score !== undefined ? Number(req.body.score) : undefined,
      text: req.body.text,
      iv: req.body.iv,
      badge: req.body.badge,
      color: req.body.color,
      date: req.body.date
    };

    // Automatisch Farbe berechnen, falls Score geändert wird
    if (payload.score !== undefined && payload.color === undefined) {
      payload.color = scoreToColor(payload.score);
    }

    const fields = [];
    const params = [];

    if (payload.score !== undefined) { z.number().int().min(1).max(100).parse(payload.score); fields.push(`score = $${fields.length + 1}`); params.push(payload.score); }
    if (payload.text !== undefined)  { z.string().max(1000).parse(payload.text); fields.push(`text = $${fields.length + 1}`); params.push(payload.text); }
    if (payload.date !== undefined)  { isoDateSchema.parse(payload.date); fields.push(`date = $${fields.length + 1}`); params.push(payload.date); }
    if (payload.iv !== undefined)    { z.string().max(32).parse(payload.iv); fields.push(`iv = $${fields.length + 1}`); params.push(payload.iv); }
    if (payload.badge !== undefined) { z.string().max(50).parse(payload.badge); fields.push(`badge = $${fields.length + 1}`); params.push(payload.badge); }
    if (payload.color !== undefined) { z.string().parse(payload.color); fields.push(`color = $${fields.length + 1}`); params.push(payload.color); }

    if (!fields.length) return res.status(400).json({ error: "No fields to update" });

    params.push(id, req.user_id);
    const result = await pool.query(
      `UPDATE entries SET ${fields.join(", ")} WHERE id = $${fields.length + 1} AND user_id = $${fields.length + 2} RETURNING *`,
      params
    );

    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// Eintrag löschen
app.delete("/entries/:id", authenticate, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await pool.query(`DELETE FROM entries WHERE id = $1 AND user_id = $2`, [id, req.user_id]);
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
