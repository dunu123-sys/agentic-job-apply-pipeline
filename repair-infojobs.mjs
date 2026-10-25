// One-shot repair: re-fetch InfoJobs details with the JSON-LD parser and patch stored rows.
import { open, setDescription } from './db.mjs';
import * as ij from './infojobs.mjs';
import { PACING } from './config.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const db = open();
const rows = db.prepare("SELECT source_id, url, title, location, posted_date FROM jobs WHERE source='infojobs'").all();
console.log('repairing', rows.length, 'InfoJobs rows...');
let ok = 0, companies = new Set();
for (const r of rows) {
  try {
    const d = await ij.detail({ url: r.url, _salary: null, posted_date: r.posted_date, location: null });
    setDescription(db, 'infojobs', r.source_id, {
      description: d.description, title: d.title, company: d.company,
      location: d.location || r.location, apply_method: 'infojobs_native',
    });
    if (d.company) companies.add(d.company);
    ok++;
  } catch (e) { console.error('  fail', r.source_id, e.message.slice(0, 50)); }
  await sleep(PACING.detail);
}
console.log(`repaired ${ok}/${rows.length}; distinct companies: ${companies.size}`);
console.log('sample companies:', [...companies].slice(0, 12).join(' | '));
db.close();
