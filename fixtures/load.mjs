// Load the synthetic fixture set into the ledger (safe demo data, no scraping).
//   node fixtures/load.mjs
// Uses JOBAPPLY_DATA_DIR when set, otherwise the repo folder.
import fs from 'node:fs';
import { open, upsertJob } from '../db.mjs';

const rows = JSON.parse(fs.readFileSync(new URL('./jobs.sample.json', import.meta.url), 'utf8'));
const db = open();

let n = 0;
for (const j of rows) {
  // upsertJob owns the discovery columns; the rest is applied afterwards.
  const { description, criteria, score, recommendation, ...job } = j;
  upsertJob(db, job);
  db.prepare(`UPDATE jobs
                 SET description = ?, criteria = ?, score = ?, recommendation = ?,
                     status = ?, scored_at = ?, llm_json = ?
               WHERE source = ? AND source_id = ?`)
    .run(description || null,
         criteria ? JSON.stringify(criteria) : null,
         score ?? null,
         recommendation || null,
         score != null ? 'scored' : 'new',
         score != null ? new Date().toISOString() : null,
         score != null ? JSON.stringify({ score, recommendation, note: 'fixture' }) : null,
         j.source, j.source_id);
  n++;
}

const total = db.prepare('SELECT COUNT(*) n FROM jobs').get().n;
console.log(`seeded ${n} fixture row(s); ledger now holds ${total}`);
db.close();
