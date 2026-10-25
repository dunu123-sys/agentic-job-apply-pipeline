// Send the operator a WhatsApp digest of jobs that are APPLY/REVIEW tier but
// not auto-applable (offsite apply, InfoJobs native, or no contact channel).
// One outreach per posting: rows already marked delivered are skipped.

import { DatabaseSync } from 'node:sqlite';
import { sendWhatsapp, buildMessage, wahaBase } from './outreach.mjs';

const DB = './jobs.sqlite';
// WAHA session is the operator's own WhatsApp -> digest goes to himself
const OPERATOR = process.env.OPERATOR_WHATSAPP || '';
const MAX_PER_MESSAGE = 12; // keep each WhatsApp message digestible

const db = new DatabaseSync(DB, { readOnly: true });
const rows = db.prepare(`
  SELECT source, source_id, title, company, location, score, recommendation, url, contact_email
  FROM jobs
  WHERE recommendation IN ('APPLY','REVIEW')
    AND (easy_apply IS NULL OR easy_apply = 0)
    AND COALESCE(outreach_status,'') NOT LIKE '%delivered%'
    AND COALESCE(outreach_status,'') NOT LIKE '%applied%'
  ORDER BY CASE recommendation WHEN 'APPLY' THEN 0 ELSE 1 END, score DESC
`).all();
db.close();

if (!rows.length) { console.log('nothing to deliver'); process.exit(0); }

console.log(`delivering ${rows.length} jobs to operator WhatsApp ${OPERATOR}`);

// split into chunks so the message stays readable
const chunks = [];
for (let i = 0; i < rows.length; i += MAX_PER_MESSAGE) chunks.push(rows.slice(i, i + MAX_PER_MESSAGE));

let sent = 0;
for (let ci = 0; ci < chunks.length; ci++) {
  const chunk = chunks[ci];
  const lines = [];
  for (const j of chunk) {
    const stars = j.recommendation === 'APPLY' ? '⭐' : '🔸';
    lines.push(
      `${stars} *${(j.title || '(sem título)').slice(0, 60)}* — ${(j.company || '?').slice(0, 35)}\n` +
      `   ${j.location || ''} · score ${j.score ?? '?'} · ${j.source === 'linkedin' ? 'LinkedIn' : 'InfoJobs'}\n` +
      `   ${j.url || ''}`
    );
  }
  const header = ci === 0
    ? `📋 *Job pipeline — ${rows.length} vaga(s) pra você ver*\n(easy-apply: aplicadas à parte; estas precisam de você)\n`
    : `📋 *continuação (${ci + 1}/${chunks.length})*\n`;
  const text = header + lines.join('\n\n');
  const r = await sendWhatsapp(OPERATOR, text);
  console.log(`chunk ${ci + 1}/${chunks.length}: HTTP ${r.status} ${r.ok ? 'OK' : 'FAIL ' + r.body}`);
  if (r.ok) sent += chunk.length;
  await new Promise(res => setTimeout(res, 1500));
}

// mark delivered in the ledger (one outreach per posting, ever)
const wdb = new DatabaseSync(DB);
for (const j of rows) {
  wdb.prepare(`UPDATE jobs SET outreach_status='delivered',
               outreach_channels=COALESCE(outreach_channels,'')||'digest-wa;',
               outreach_at=? WHERE source=? AND source_id=?`)
    .run(new Date().toISOString(), j.source, j.source_id);
}
wdb.close();
console.log(`delivered ${sent}/${rows.length}; ledger updated`);
