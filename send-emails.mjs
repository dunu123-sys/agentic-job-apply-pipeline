// Send application emails for APPLY/REVIEW jobs that expose a recruiter email.
// CV attached from Documents/Curriculum.pdf. One email per posting (ledger-guarded).
//
//   node send-emails.mjs          -> SHOW what would be sent (no send)
//   node send-emails.mjs --send   -> actually send via gog (Gmail, you@example.com)

import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const DB = './jobs.sqlite';
const CV = process.env.CV_PATH || './resume.pdf';
const FROM = process.env.MAIL_FROM || 'you@example.com';
const SEND = process.argv.includes('--send');

const db = new DatabaseSync(DB, { readOnly: true });
const jobs = db.prepare(`
  SELECT source, source_id, title, company, location, contact_email, recommendation
  FROM jobs
  WHERE contact_email IS NOT NULL
    AND recommendation IN ('APPLY','REVIEW')
    AND (outreach_status IS NULL OR outreach_status NOT LIKE '%email%')
  ORDER BY score DESC`).all();
db.close();

if (!jobs.length) { console.log('no eligible jobs with recruiter emails'); process.exit(0); }
console.log(`eligible: ${jobs.length} job(s)${SEND ? ' — SENDING' : ' — PREVIEW (use --send to fire)'}\n`);

let sent = 0;
for (const j of jobs) {
  const subject = `Candidatura — ${j.title || 'Vaga'}${j.company ? ' | ' + j.company : ''}`;
  const body = [
    'Olá,',
    '',
    `Vi a vaga de ${j.title || 'desenvolvedor'}${j.company ? ' na ' + j.company : ''} e gostaria de me candidatar.`,
    '',
    'Sou desenvolvedor de sistemas e dados, com experiência sólida em C#, .NET, SQL Server e Python —',
    'automação de processos, integrações de dados e dashboards em Power BI, tanto em backend quanto',
    'no apoio a sistemas corporativos. Acredito que meu perfil conversa bem com o que a vaga pede.',
    '',
    'Tenho inglês fluente e estou em São Paulo (remoto ou híbrido). Encontro-se anexado o meu currículo;',
    'fico à disposição para conversar.',
    '',
    'Obrigado pelo seu tempo!',
    '',
    process.env.CANDIDATE_NAME || 'Example Candidate',
    process.env.CANDIDATE_PHONE || '+55 11 00000-0000',
    process.env.MAIL_FROM || 'you@example.com',
  ].join('\r\n');

  console.log('─'.repeat(72));
  console.log('TO     :', j.contact_email, `(verdict ${j.recommendation})`);
  console.log('SUBJECT:', subject);
  console.log('ATTACH :', CV, fs.existsSync(CV) ? '(exists)' : '(MISSING!)');
  console.log('BODY   :');
  console.log(body.split('\r\n').map(l => '  ' + l).join('\n'));

  if (SEND) {
    // write body to a temp file: PT text through the shell mangles quotes
    const tmp = './email-body.txt';
    fs.writeFileSync(tmp, body, 'utf8');
    try {
      execFileSync('gog', [
        'gmail', 'send',
        '--from', FROM,
        '--to', j.contact_email,
        '--subject', subject,
        '--body-file', tmp,
        '--attach', CV,
      ], { encoding: 'utf8', timeout: 60000 });
      const wdb = new DatabaseSync(DB);
      wdb.prepare(`UPDATE jobs SET outreach_status=COALESCE(outreach_status,'')||'emailed;',
                   outreach_channels=COALESCE(outreach_channels,'')||'email;', outreach_at=? WHERE source=? AND source_id=?`)
        .run(new Date().toISOString(), j.source, j.source_id);
      wdb.close();
      sent++;
      console.log('>>> SENT ✅');
    } catch (e) {
      console.log('>>> SEND FAILED:', String(e).slice(0, 160));
    }
  }
  console.log('');
}
if (SEND) console.log(`done: ${sent}/${jobs.length} emails sent`);
else console.log('preview only — run with --send to fire');
