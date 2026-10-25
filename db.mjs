// SQLite store for the job pipeline. node:sqlite is in Node 24+ — no installs.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA_DIR = process.env.JOBAPPLY_DATA_DIR
  || path.dirname(fileURLToPath(import.meta.url));
export const DB_PATH = path.join(DATA_DIR, 'jobs.sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  source        TEXT NOT NULL,             -- linkedin | infojobs
  source_id     TEXT NOT NULL,            -- LinkedIn numeric urn | InfoJobs vacancyId
  url           TEXT,
  title         TEXT,
  company       TEXT,
  location      TEXT,
  posted_date   TEXT,
  easy_apply    INTEGER,                  -- 1/0/null(unknown)
  apply_method  TEXT,                     -- easy_apply | offsite | infojobs_native | unknown
  apply_url     TEXT,
  description   TEXT,
  criteria      TEXT,                     -- JSON array
  found_by      TEXT,                     -- JSON: queries that surfaced it
  first_seen    TEXT,
  last_seen     TEXT,
  score         INTEGER,
  recommendation TEXT,                    -- APPLY | REVIEW | SKIP
  llm_json      TEXT,                     -- full parsed LLM verdict
  gate_fail     TEXT,                     -- hard-gate reason, if any
  scored_at     TEXT,
  status        TEXT DEFAULT 'new',       -- new|scored|delivered|applied|skipped
  PRIMARY KEY (source, source_id)
);
CREATE INDEX IF NOT EXISTS idx_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_rec ON jobs(recommendation);
`;

export function open() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(SCHEMA);
  // lightweight migrations (idempotent) — ALTER throws if the column exists
  for (const col of ['contact_email TEXT', 'contact_phone TEXT', 'contact_whatsapp TEXT',
                     'outreach_status TEXT', 'outreach_channels TEXT DEFAULT \'\'', 'outreach_at TEXT',
                     'approved INTEGER DEFAULT 0', 'approved_at TEXT', 'apply_status TEXT',
                     'approved_via TEXT']) {
    try { db.exec('ALTER TABLE jobs ADD COLUMN ' + col); } catch { /* exists */ }
  }
  return db;
}

// AUTO-QUEUE POLICY (operator rule 2026-10-23): every job scoring >= 80 that
// is InfoJobs-native or LinkedIn Easy Apply goes straight into the apply
// queue (approved=1) so the runners can apply it automatically — no manual
// approval needed for this tier. Idempotent: never touches already-approved
// or already-applied/blocked rows.
export function autoQueue80(db) {
  const r = db.prepare(`
    UPDATE jobs SET approved=1, approved_at=@now, approved_via='auto-80'
    WHERE approved=0 AND COALESCE(score,0) >= 80
      AND (COALESCE(easy_apply,0)=1 OR source='infojobs' OR COALESCE(apply_method,'')='infojobs_native')
      AND COALESCE(apply_status,'')='' AND COALESCE(outreach_status,'')=''
      AND COALESCE(apply_status,'') NOT LIKE '%blocked%'`).run({ now: new Date().toISOString() });
  return r.changes;
}

export function upsertJob(db, j) {
  const now = new Date().toISOString();
  const { _salary, ...clean } = j;
  const rec = { ...clean, found_by: JSON.stringify(j.found_by || []) };
  db.prepare(`
    INSERT INTO jobs (source, source_id, url, title, company, location, posted_date,
                       easy_apply, apply_method, apply_url, found_by, first_seen, last_seen, status)
    VALUES (@source, @source_id, @url, @title, @company, @location, @posted_date,
            @easy_apply, @apply_method, @apply_url, @found_by, @now, @now, 'new')
    ON CONFLICT(source, source_id) DO UPDATE SET
      last_seen = @now,
      url = COALESCE(excluded.url, url),
      title = COALESCE(excluded.title, title),
      company = COALESCE(excluded.company, company),
      location = COALESCE(excluded.location, location),
      posted_date = COALESCE(excluded.posted_date, posted_date),
      easy_apply = CASE WHEN excluded.easy_apply IS NOT NULL THEN excluded.easy_apply ELSE easy_apply END
  `).run({ ...rec, now });
}

export function isNew(db, source, source_id) {
  const r = db.prepare('SELECT first_seen FROM jobs WHERE source=? AND source_id=?').get(source, source_id);
  return !r;
}

export function setDescription(db, source, source_id, fields) {
  const sets = [], args = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    sets.push(k + ' = @' + k);
    args[k] = typeof v === 'object' ? JSON.stringify(v) : v;
  }
  if (!sets.length) return;
  args.source = source; args.source_id = source_id;
  db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE source=@source AND source_id=@source_id`).run(args);
}

export function pendingScore(db, limit = 200) {
  return db.prepare(
    `SELECT source, source_id, title, company, location, description, criteria, easy_apply
     FROM jobs WHERE status='new' AND description IS NOT NULL AND length(description) > 200
     ORDER BY first_seen ASC LIMIT ?`
  ).all(limit);
}

// ---- settings (operator config: score combo etc., CONFIG tab 2026-10-25) ----
export function getSetting(db, key, fallback = null) {
  db.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`).run();
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : fallback;
}
export function setSetting(db, key, value) {
  db.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`).run();
  db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(key, String(value), new Date().toISOString());
}

export function saveScore(db, source, source_id, verdict) {
  db.prepare(`UPDATE jobs SET score=?, recommendation=?, llm_json=?, gate_fail=?, scored_at=?, status='scored'
               WHERE source=? AND source_id=?`)
    .run(verdict.score, verdict.recommendation, JSON.stringify(verdict), verdict.gate_fail || null,
         new Date().toISOString(), source, source_id);
}

export function stats(db) {
  const byStatus = db.prepare('SELECT status, COUNT(*) n FROM jobs GROUP BY status').all();
  const byRec = db.prepare("SELECT recommendation, COUNT(*) n FROM jobs WHERE status='scored' GROUP BY recommendation").all();
  const bySource = db.prepare('SELECT source, COUNT(*) n FROM jobs GROUP BY source').all();
  const total = db.prepare('SELECT COUNT(*) n FROM jobs').get().n;
  return { total, byStatus, byRec, bySource };
}
