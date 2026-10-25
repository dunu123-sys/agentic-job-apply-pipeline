// assisted-apply.mjs — HYBRID InfoJobs applier: automation navigates + verifies,
// the OPERATOR clicks CANDIDATAR-ME (real input passes the Human-Security gate).
//   CDP_PORT=9224 node assisted-apply.mjs <source_id>...
// For each job: navigate → announce → poll for the applied state (hero gone /
// confirm modal) → ledger + audit → next.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:' + (process.env.CDP_PORT || '9224');
const DB = './jobs.sqlite';
const AUDIT = './apply-audit.log';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const list = await (await fetch(BASE + '/json/list')).json();
const t = list.find(x => x.type === 'page' && /infojobs/.test(x.url));
if (!t) { console.log('no infojobs tab — launch the ij-profile Chrome first'); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
let seq = 0;
const call = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  const on = (ev) => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', on); m.error ? rej(new Error(method)) : res(m.result); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { ws.removeEventListener('message', on); rej(new Error(method + ' timeout')); }, 30000);
});
const evalIn = async (expr) => {
  const r = await call('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 200));
  return r.result.value;
};

const db = new DatabaseSync(DB, { readOnly: true });
const ids = process.argv.slice(2);
const jobs = db.prepare(`SELECT source_id, title, company, url FROM jobs
  WHERE source='infojobs' AND (${ids.map(() => 'source_id=?').join(' OR ')})`).all(...ids);
db.close();

function markApplied(source_id, note) {
  const db = new DatabaseSync(DB);
  db.prepare(`UPDATE jobs SET outreach_status='applied',
    outreach_channels=COALESCE(outreach_channels,'')||'infojobs-native;',
    outreach_at=?, apply_status='applied-infojobs-native' WHERE source='infojobs' AND source_id=?`)
    .run(new Date().toISOString(), source_id);
  db.close();
  fs.appendFileSync(AUDIT, `${new Date().toISOString()} infojobs:${source_id} APPLIED (hybrid: operator click, automation navigate+verify) ${note}\n`);
}

let done = 0;
for (const job of jobs) {
  console.log(`\n=========== ${job.company.slice(0,25)} — ${job.title.slice(0,50)}`);
  console.log(`>>> OPEN THE BROWSER AND CLICK "CANDIDATAR-ME" NOW <<<`);
  await call('Page.navigate', { url: job.url });
  await sleep(4000);
  // scroll the hero into view for the operator
  await evalIn(`{ const b=[...document.querySelectorAll('a,button')].find(x=>x.offsetParent!==null && /candidatar-me/i.test((x.textContent||'').trim()) && (String(x.className).includes('btn-d-block')||x.getBoundingClientRect().width>200)); if (b) { b.scrollIntoView({block:'center'}); return true; } return false; }`);

  let applied = false;
  for (let poll = 0; poll < 45; poll++) {   // up to ~90s
    await sleep(2000);
    const st = await evalIn(`return { heroGone: ![...document.querySelectorAll('a,button')].some(b=>b.offsetParent!==null && /candidatar-me/i.test((b.textContent||'').trim()) && String(b.className).includes('btn-d-block')),
      modal: (([...document.querySelectorAll('.modal')].find(x=>getComputedStyle(x).display==='block')||{}).innerText||'').slice(0,80) };`);
    if (st.heroGone || /se candidatou/i.test(st.modal)) {
      applied = true;
      // close any upsell modal
      await evalIn(`{ const m=[...document.querySelectorAll('.modal')].find(x=>getComputedStyle(x).display==='block'); if (m) { const x=m.querySelector('[data-dismiss], button.close, a.close'); if (x) x.click(); } return 'ok'; }`);
      break;
    }
  }
  if (applied) {
    markApplied(job.source_id, (job.title || '').slice(0, 60));
    console.log(`✅ ${job.company.slice(0,20)} APPLIED + verified (hero gone)`);
    done++;
  } else {
    console.log(`⏳ ${job.company.slice(0,20)} — no click detected in 90s, skipping (re-run later)`);
  }
  await sleep(3000);
}
ws.close();
console.log(`\nDone: ${done}/${jobs.length} applied.`);
