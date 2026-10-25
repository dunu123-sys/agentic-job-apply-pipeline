// Backfill contact columns from stored descriptions + report coverage.
import { open } from './db.mjs';
import { extractContacts } from './outreach.mjs';

const db = open();
const rows = db.prepare('SELECT source, source_id, title, company, description, recommendation, easy_apply FROM jobs').all();
let withEmail = 0, withWhats = 0, withPhone = 0, applyList = [];
const samples = { email: [], whatsapp: [] };

for (const r of rows) {
  const c = extractContacts(r.description || '');
  db.prepare('UPDATE jobs SET contact_email=?, contact_phone=?, contact_whatsapp=? WHERE source=? AND source_id=?')
    .run(c.contact_email, c.contact_phone, c.contact_whatsapp, r.source, r.source_id);
  if (c.contact_email) { withEmail++; if (samples.email.length < 8) samples.email.push(c.contact_email + '  <- ' + r.title); }
  if (c.contact_whatsapp) { withWhats++; if (samples.whatsapp.length < 8) samples.whatsapp.push(c.contact_whatsapp + '  <- ' + r.title); }
  if (c.contact_phone) withPhone++;
  if (r.recommendation === 'APPLY') applyList.push({ ...r, ...c });
}

console.log('total jobs:', rows.length);
console.log('with email:', withEmail, '| with whatsapp:', withWhats, '| with phone:', withPhone);
console.log('\nAPPLY list (' + applyList.length + '):');
for (const j of applyList) {
  console.log('  [' + j.score + ']', (j.title || '').slice(0, 45), '@', j.company,
    '| EA=' + j.easy_apply, '| email=' + (j.contact_email || '—'), '| zap=' + (j.contact_whatsapp || '—'));
}
console.log('\nsample emails:'); samples.email.forEach(s => console.log('  ', s));
console.log('\nsample whatsapps:'); samples.whatsapp.forEach(s => console.log('  ', s));

const ea = applyList.filter(j => j.easy_apply === 1);
const em = applyList.filter(j => !j.easy_apply && j.contact_email);
const zp = applyList.filter(j => !j.easy_apply && !j.contact_email && j.contact_whatsapp);
console.log('\n=== APPLY routing ===');
console.log('Easy Apply (auto-apply):', ea.length);
console.log('Email send:', em.length, '| WhatsApp send:', zp.length,
  '| neither (digest to operator):', applyList.length - ea.length - em.length - zp.length);
db.close();
