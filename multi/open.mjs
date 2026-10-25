// multi/open.mjs — path-parameterized DB opener (NEW).
// Production db.mjs open() hardcodes jobs.sqlite; the multi pipeline must be
// able to run against a TEST COPY, so it opens its own DatabaseSync handle
// and reuses production's row helpers (they only need a db handle).
import { DatabaseSync } from 'node:sqlite';

export function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  // ensure the settings table exists (same DDL as production db.mjs)
  db.exec(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`);
  return db;
}
