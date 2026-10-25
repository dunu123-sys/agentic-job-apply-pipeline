// verify-gmail.mjs — confirm applications via the LinkedIn confirmation emails.
// Operator insight 2026-10-22: every successful apply triggers a Gmail
// "Example Candidate, your application was sent to <COMPANY>" from
// jobs-noreply@linkedin.com. This is the authoritative external verification.
//   node verify-gmail.mjs [days]        (default 2)
import { execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const days = process.argv[2] || 2;
const out = execSync(
  `gog gmail search "from:jobs-noreply@linkedin.com \\"your application was sent\\" newer_than:${days}d"`,
  { encoding: 'utf8', timeout: 60000 }
);
const confirmed = [...out.matchAll(/your application was sent to (.+?)\s{2,}/gi)].map(m => m[1].trim().toLowerCase());
console.log('Gmail confirmations (last ' + days + 'd):');
confirmed.forEach(c => console.log('  ✔', c));

const db = new DatabaseSync('./jobs.sqlite', { readOnly: true });
const approved = db.prepare(`SELECT source_id, title, company, apply_status FROM jobs WHERE approved=1`).all();
db.close();
console.log('\nApproved queue reconciliation:');
let nOk = 0;
for (const j of approved) {
  const company = (j.company || '').toLowerCase().split(/\s+/)[0];
  const hit = confirmed.find(c => c.includes(company));
  if (hit) { nOk++; console.log(`  ✔ ${j.company} — email-confirmed`); }
  else console.log(`  ✗ ${j.company} — ${j.apply_status || 'not applied yet'} (no email)`);
}
console.log(`\n${nOk}/${approved.length} email-confirmed.`);
