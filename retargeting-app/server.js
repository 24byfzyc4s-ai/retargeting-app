import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { pool, initDb } from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function nowIso() {
  return new Date().toISOString();
}

function basicAdminAuth(req, res, next) {
  const expectedUser = process.env.ADMIN_USER;
  const expectedPass = process.env.ADMIN_PASS;

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Admin"');
    return res.status(401).send("Authentifizierung erforderlich");
  }

  const base64 = auth.split(" ")[1];
  const [user, pass] = Buffer.from(base64, "base64").toString().split(":");

  if (user === expectedUser && pass === expectedPass) {
    return next();
  }

  res.setHeader("WWW-Authenticate", 'Basic realm="Admin"');
  return res.status(401).send("Falsche Zugangsdaten");
}

async function getOrCreateSession(req) {
  const sid = req.headers["x-session-id"];
  if (!sid || typeof sid !== "string") return null;

  const existing = await pool.query("SELECT * FROM sessions WHERE id = $1", [sid]);
  if (existing.rows.length) return existing.rows[0];

  await pool.query(
    "INSERT INTO sessions (id, created_at, first_event, character) VALUES ($1, $2, $3, $4)",
    [sid, nowIso(), null, null]
  );

  const created = await pool.query("SELECT * FROM sessions WHERE id = $1", [sid]);
  return created.rows[0];
}

app.post("/api/session/start", async (req, res) => {
  const sessionId = crypto.randomUUID();
  await pool.query(
    "INSERT INTO sessions (id, created_at, first_event, character) VALUES ($1, $2, $3, $4)",
    [sessionId, nowIso(), null, null]
  );
  res.json({ sessionId });
});

app.post("/api/track/first-event", async (req, res) => {
  const session = await getOrCreateSession(req);
  if (!session) return res.status(400).json({ error: "Missing session" });

  const { event } = req.body;
  if (typeof event !== "string" || event.length > 80) {
    return res.status(400).json({ error: "Invalid event" });
  }

  await pool.query(
    "UPDATE sessions SET first_event = $1 WHERE id = $2 AND first_event IS NULL",
    [event, session.id]
  );

  res.json({ ok: true });
});

app.post("/api/character/set", async (req, res) => {
  const session = await getOrCreateSession(req);
  if (!session) return res.status(400).json({ error: "Missing session" });

  const { character } = req.body;
  const allowed = ["Scholar", "Entrepreneur", "Activist", "Influencer"];
  if (!allowed.includes(character)) {
    return res.status(400).json({ error: "Invalid character" });
  }

  await pool.query("UPDATE sessions SET character = $1 WHERE id = $2", [character, session.id]);
  res.json({ ok: true });
});

app.post("/api/survey/anon", async (req, res) => {
  const session = await getOrCreateSession(req);
  if (!session) return res.status(400).json({ error: "Missing session" });

  const answers = req.body?.answers;
  if (!answers || typeof answers !== "object") {
    return res.status(400).json({ error: "Invalid answers" });
  }

  const enriched = {
    ...answers,
    character: session.character ?? null,
    first_event: session.first_event ?? null
  };

  await pool.query(
    "INSERT INTO anon_responses (session_id, created_at, answers_json) VALUES ($1, $2, $3)",
    [session.id, nowIso(), JSON.stringify(enriched)]
  );

  res.json({ ok: true });
});

app.post("/api/survey/personal", async (req, res) => {
  const session = await getOrCreateSession(req);
  if (!session) return res.status(400).json({ error: "Missing session" });

  const name = req.body?.name;
  const answers = req.body?.answers;

  if (typeof name !== "string" || name.trim().length < 2 || name.length > 80) {
    return res.status(400).json({ error: "Invalid name" });
  }
  if (!answers || typeof answers !== "object") {
    return res.status(400).json({ error: "Invalid answers" });
  }

  const enriched = {
    ...answers,
    character: session.character ?? null,
    first_event: session.first_event ?? null
  };

  const insert = await pool.query(
    "INSERT INTO personal_responses (session_id, created_at, name, answers_json) VALUES ($1, $2, $3, $4) RETURNING id",
    [session.id, nowIso(), name.trim(), JSON.stringify(enriched)]
  );

  const personalId = insert.rows[0].id;
  const match = await computeBestMatchForPersonal(personalId);

  res.json({ ok: true, match });
});

function scorePair(pAns, aAns) {
  const weights = {
    books_home: 3,
    parents_job: 3,
    device: 2,
    area: 2,
    future_plan: 2,
    sidejob: 1,
    commute: 1,
    character: 3,
    first_event: 2
  };

  let score = 0;
  const rationale = [];

  for (const key of Object.keys(weights)) {
    const w = weights[key];
    const pv = pAns[key];
    const av = aAns[key];
    if (pv === undefined || av === undefined) continue;

    if (pv === av) {
      score += w;
      rationale.push({ key, match: true, weight: w, p: pv, a: av });
    } else {
      score -= Math.min(1, w * 0.25);
      rationale.push({ key, match: false, weight: w, p: pv, a: av });
    }
  }

  return { score: Number(score.toFixed(2)), rationale };
}

async function computeBestMatchForPersonal(personalId) {
  const pRes = await pool.query("SELECT * FROM personal_responses WHERE id = $1", [personalId]);
  if (!pRes.rows.length) return null;
  const p = pRes.rows[0];
  const pAns = p.answers_json;

  const aRes = await pool.query("SELECT * FROM anon_responses");
  const anons = aRes.rows;

  let best = null;

  for (const a of anons) {
    const aAns = a.answers_json;
    const { score, rationale } = scorePair(pAns, aAns);

    if (!best || score > best.score) {
      best = { anon_id: a.id, score, rationale };
    }
  }

  if (!best) return null;

  await pool.query(
    "INSERT INTO matches (personal_id, anon_id, score, rationale_json, created_at) VALUES ($1, $2, $3, $4, $5)",
    [personalId, best.anon_id, best.score, JSON.stringify(best.rationale), nowIso()]
  );

  return best;
}

app.get("/api/admin/overview", basicAdminAuth, async (req, res) => {
  const sessions = await pool.query("SELECT * FROM sessions ORDER BY created_at DESC");
  const anons = await pool.query("SELECT * FROM anon_responses ORDER BY created_at DESC");
  const personals = await pool.query("SELECT * FROM personal_responses ORDER BY created_at DESC");
  const matches = await pool.query("SELECT * FROM matches ORDER BY created_at DESC");

  res.json({
    sessions: sessions.rows,
    anons: anons.rows,
    personals: personals.rows,
    matches: matches.rows
  });
});

app.get("/api/admin/stats", basicAdminAuth, async (req, res) => {
  const personals = (await pool.query("SELECT * FROM personal_responses")).rows;
  const anons = (await pool.query("SELECT * FROM anon_responses")).rows;
  const matches = (await pool.query("SELECT * FROM matches")).rows;

  const anonById = new Map(anons.map(a => [a.id, a]));
  const personalById = new Map(personals.map(p => [p.id, p]));

  let correct = 0;
  const total = matches.length;
  const keyStats = new Map();

  for (const m of matches) {
    const p = personalById.get(m.personal_id);
    const a = anonById.get(m.anon_id);
    if (p && a && p.session_id === a.session_id) correct++;

    const rationale = m.rationale_json ?? [];
    for (const r of rationale) {
      if (!r?.key) continue;
      const cur = keyStats.get(r.key) ?? { matchTrue: 0, matchFalse: 0 };
      if (r.match) cur.matchTrue++;
      else cur.matchFalse++;
      keyStats.set(r.key, cur);
    }
  }

  const accuracy = total === 0 ? null : Number(((correct / total) * 100).toFixed(1));

  const topKeys = [...keyStats.entries()]
    .map(([key, v]) => ({ key, ...v, total: v.matchTrue + v.matchFalse }))
    .sort((x, y) => y.matchTrue - x.matchTrue)
    .slice(0, 10);

  const counts = {
    sessions: Number((await pool.query("SELECT COUNT(*)::int AS c FROM sessions")).rows[0].c),
    anon: anons.length,
    personal: personals.length,
    matches: matches.length
  };

  res.json({ counts, accuracy, correct, total, topKeys });
});

app.get("/api/admin/export.csv", basicAdminAuth, async (req, res) => {
  const matches = (await pool.query("SELECT * FROM matches ORDER BY created_at DESC")).rows;
  const personals = (await pool.query("SELECT * FROM personal_responses")).rows;
  const anons = (await pool.query("SELECT * FROM anon_responses")).rows;

  const anonById = new Map(anons.map(a => [a.id, a]));
  const personalById = new Map(personals.map(p => [p.id, p]));

  const header = [
    "created_at",
    "personal_id",
    "name",
    "anon_id",
    "score",
    "is_correct",
    "matched_keys"
  ];

  const rows = [header.join(",")];

  for (const m of matches) {
    const p = personalById.get(m.personal_id);
    const a = anonById.get(m.anon_id);

    const isCorrect = p && a && p.session_id === a.session_id ? "1" : "0";
    const matchedKeys = (m.rationale_json ?? [])
      .filter(r => r.match)
      .map(r => r.key)
      .join("|");

    const safe = (s) => `"${String(s ?? "").replaceAll('"', '""')}"`;

    rows.push([
      safe(m.created_at),
      safe(m.personal_id),
      safe(p?.name ?? ""),
      safe(m.anon_id),
      safe(m.score),
      safe(isCorrect),
      safe(matchedKeys)
    ].join(","));
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=retargeting_export.csv");
  res.send(rows.join("\n"));
});

app.post("/api/admin/reset", basicAdminAuth, async (req, res) => {
  await pool.query("DELETE FROM matches");
  await pool.query("DELETE FROM anon_responses");
  await pool.query("DELETE FROM personal_responses");
  await pool.query("DELETE FROM sessions");
  res.json({ ok: true });
});

const port = process.env.PORT || 3000;

initDb().then(() => {
  app.listen(port, () => {
    console.log(`Server läuft auf Port ${port}`);
  });
});