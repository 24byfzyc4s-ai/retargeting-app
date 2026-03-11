import pkg from "pg";
const { Pool } = pkg;

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL fehlt. Bitte in Render oder lokal setzen.");
}

export const pool = new Pool({
  connectionString,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL,
      first_event TEXT,
      character TEXT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS anon_responses (
      id SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      answers_json JSONB NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS personal_responses (
      id SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      name TEXT NOT NULL,
      answers_json JSONB NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS matches (
      id SERIAL PRIMARY KEY,
      personal_id INTEGER NOT NULL,
      anon_id INTEGER NOT NULL,
      score REAL NOT NULL,
      rationale_json JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );
  `);
}