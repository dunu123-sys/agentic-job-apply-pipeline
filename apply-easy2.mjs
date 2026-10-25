// apply-easy2.mjs — Easy Apply walker codified from the LIVE-verified procedure
// (EASY-APPLY-PROCEDURE.md). Drives the EXISTING headed Chrome on :9223 via raw
// CDP — same mechanics proven by hand on the Dexian application.
//
//   node apply-easy2.mjs            -> DRY: walk, fill, stop BEFORE submit
//   node apply-easy2.mjs --live     -> submit for real (approved queue only)
//
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { resolveAnswer, norm } from './answers.mjs';

const BASE = 'http://127.0.0.1:9223';
const DB = './jobs.sqlite';
const LIVE = process.argv.includes('--live');
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').split('=')[1];
const AUDIT = './apply-audit.log';
const HOURLY_CAP = 5;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- raw CDP ----------------------------------------------------------------
async function pageTarget() {
  const list = await (await fetch(BASE + '/json/list')).json();
  return list.find(x => x.type === 'page' && /linkedin\.com/.test(x.url))
      || list.find(x => x.type === 'page' && !/^chrome:/.test(x.url));
}
async function connect() {
  const t = await pageTarget();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let seq = 0;
  const call = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    const on = (ev) => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', on); m.error ? rej(new Error(method)) : res(m.result); } };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { ws.removeEventListener('message', on); rej(new Error(method + ' timeout')); }, 25000);
  });
  await call('Runtime.enable'); await call('Page.enable');
  const HELPERS = `
    var __vis = (el) => el && el.offsetParent !== null;
    var __clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    var __modal = () => {
      let anchor = [...document.querySelectorAll('button')].find(b => __vis(b) && /^(next|submit application|enviar candidatura|review)/i.test(__clean(b.textContent)))
                || [...document.querySelectorAll('button')].find(b => __vis(b) && /^dismiss$/i.test(__clean(b.textContent)));
      if (!anchor) anchor = [...document.querySelectorAll('input')].find(i => __vis(i) && /@|\\d{10,}/.test(i.value || ''));
      if (!anchor) return null;
      let best = null, bestArea = 0, el = anchor.parentElement;
      for (let i = 0; i < 9 && el; i++) { const a = (el.offsetWidth||0)*(el.offsetHeight||0);
        if (el.tagName === 'DIV' && a > bestArea) { bestArea = a; best = el; } el = el.parentElement; }
      return best || document.body;
    };`;
  const evalIn = async (expr) => {
    const r = await call('Runtime.evaluate', {
      expression: `${HELPERS}\n(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 200) + '\nEXPR<<<' + expr.slice(0, 500) + '>>>');
    return r.result.value;
  };
  // REAL mouse click: scrollIntoView + CDP Input.dispatchMouseEvent at coords.
  // LinkedIn's React handlers ignore bare DOM .click() on step buttons
  // (Next/Review/Submit) in some modals — real mouse events always work.
  const realClick = async (selectorExpr) => {
    const box = await evalIn(`{ const el = (${selectorExpr}); if (!el || !el.offsetParent) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }`);
    if (!box) return 'not-found';
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await new Promise(r => setTimeout(r, 150));
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 60));
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    return true;
  };
  return { ws, call, evalIn, realClick };
}


// ---- dual-mode advance: DOM click first, real mouse as fallback ----------------
// LinkedIn A/B-tests modal variants: some modals only react to DOM .click(),
// others (React synthetic handlers) only to real CDP mouse events. Always
// verify the page actually advanced; fall back to the other mechanism.
async function pageState(conn) {
  return conn.evalIn(`{ const m = __modal(); const t = m && m !== document.body ? m.innerText : document.body.innerText.slice(0, 3000);
    return { pg: (t.match(/\\d\\/\\d pages/) || [''])[0], review: /review your application/i.test(t),
             modal: !!(m && m !== document.body),
             submitted: /application submitted/i.test(document.body.innerText.slice(0, 2500)) }; }`);
}

async function advanceClick(conn, selectorExpr, mode) {
  const before = await pageState(conn);
  if (mode !== 'real') {
    const r = await conn.evalIn(`{ const b = (${selectorExpr}); if (b) { b.click(); return true; } return false; }`);
    if (r) { await sleep(2500); const a = await pageState(conn);
      if (a.pg !== before.pg || a.review || a.submitted || a.modal !== before.modal) return 'dom'; }
  }
  if (mode !== 'dom') {
    const r2 = await conn.realClick(selectorExpr);
    if (r2 === true) { await sleep(2500); const a = await pageState(conn);
      if (a.pg !== before.pg || a.review || a.submitted || a.modal !== before.modal) return 'real'; }
  }
  return 'failed';
}

// ---- targets ----------------------------------------------------------------
function targets() {
  const db = new DatabaseSync(DB, { readOnly: true });
  const rows = db.prepare(`
    SELECT source, source_id, title, company, url, score
    FROM jobs WHERE approved=1 AND url IS NOT NULL AND COALESCE(easy_apply,0)=1
      AND COALESCE(apply_status,'') NOT LIKE '%applied%'
      AND COALESCE(apply_status,'') NOT LIKE '%blocked%'
      AND COALESCE(outreach_status,'') NOT LIKE '%applied%'
      AND COALESCE(outreach_status,'') NOT LIKE '%blocked%'
    ORDER BY score DESC`).all();  db.close();
  return rows.filter(r => !ONLY || r.source_id === ONLY);
}

function markApplied(source, source_id, note) {
  const db = new DatabaseSync(DB);
  db.prepare(`UPDATE jobs SET outreach_status='applied',
              outreach_channels=COALESCE(outreach_channels,'')||'easyapply-${LIVE ? 'live' : 'dry'};',
              outreach_at=?, apply_status=? WHERE source=? AND source_id=?`)
    .run(new Date().toISOString(), LIVE ? 'applied-easy-apply' : 'filled-not-submitted', source, source_id);
  db.close();
  fs.appendFileSync(AUDIT, `${new Date().toISOString()} ${LIVE ? 'LIVE' : 'DRY'} ${source}:${source_id} ${note}\n`);
}

// ---- the walker ---------------------------------------------------------------
const YES = ['sim', 'yes', 'nao', 'no', 'não'];
const mapAnswerToOption = (answer) => {
  const a = norm(answer).split(/[,.;!?]|\s/)[0]; // first word only
  if (/^(sim|yes|s|y|verdadeiro|true|positivo)$/.test(a)) return 'yes';
  if (/^(nao|no|n|falso|false|negativo)$/.test(a)) return 'no';
  return null; // not a yes/no
};
const optionMatches = (optionText, want) => {
  const op = norm(optionText);
  const yes = ['yes', 'sim', 'y', 's', 'verdadeiro'];
  const no = ['no', 'nao', 'n', 'falso'];
  return want === 'yes' ? yes.includes(op) : no.includes(op);
};

async function applyOne(conn, job) {
  const { evalIn, call, realClick } = conn;
  const log = [];
  console.log(`\n--- ${job.title} @ ${job.company} (score ${job.score})`);

  await call('Page.navigate', { url: job.url });
  await sleep(4000);
  if (/authwall/i.test(String(await evalIn('return location.href')))) { console.log('  AUTHWALL — skip'); return { ok: false, why: 'authwall' }; }

  const st = await evalIn(`return { applied: /application status|você se candidatou|applied/i.test(document.body.innerText.slice(0,2000)),
    btn: [...document.querySelectorAll('button')].filter(__vis).map(b => (b.getAttribute('aria-label')||'') + ' ' + __clean(b.textContent)).find(x => /easy apply/i.test(x)) || null };`);
  if (st.applied) { console.log('  already applied — skip'); markApplied(job.source, job.source_id, 'already-applied'); return { ok: true, already: true }; }
  if (!st.btn) { console.log('  no Easy Apply button — skip'); return { ok: false, why: 'no-ea-button' }; }

  // click Easy Apply — dual mode (DOM first, real mouse fallback)
  const eaClick = await advanceClick(conn, `[...document.querySelectorAll('button')].filter(__vis).find(x => /easy apply/i.test((x.getAttribute('aria-label')||'') + ' ' + __clean(x.textContent)))`);
  log.push('ea-open: ' + eaClick);
  await sleep(3500);

  let page = 0, submitted = false, dryStopped = false;
  while (page < 8) {
    page++;
    let dump = await evalIn(`
      const scope = __modal() || document.body;
      const fields = [...scope.querySelectorAll('input[type=text],input[type=tel],input[type=email],input[type=number],textarea')].filter(__vis).map(f => ({
        id: f.id, label: __clean(f.getAttribute('aria-label')).slice(0,120), value: f.value }));
      const radios = [...scope.querySelectorAll('input[type=radio]')].filter(__vis).map(r => {
        const box = r.closest('div')?.parentElement;
        return { id: r.id, group: r.name, question: __clean(r.getAttribute('aria-label')).slice(0,140),
                 option: __clean(box?.querySelector('p, span')?.textContent), checked: r.checked };
      });
      const btns = [...scope.querySelectorAll('button')].filter(__vis).map(b => ({ t: __clean(b.textContent), aria: b.getAttribute('aria-label')||'' }))
        .filter(b => /^(next|review|submit application|back|edit)$/i.test(b.t));
      const pg = __clean(scope.querySelector('*')?.parentElement?.innerText || '').match(/(\\d)\\/(\\d) pages/)?.[0] || '';
      return { fields, radios, btns, pg };`);
    if (!dump.pg && !dump.btns.length && !dump.fields.length && !dump.radios.length && page === 1) {
      await sleep(4000);
      dump = await evalIn(`
      const scope = __modal() || document.body;
      const fields = [...scope.querySelectorAll('input[type=text],input[type=tel],input[type=email],input[type=number],textarea')].filter(__vis).map(f => ({
        id: f.id, label: __clean(f.getAttribute('aria-label')).slice(0,120), value: f.value }));
      const radios = [...scope.querySelectorAll('input[type=radio]')].filter(__vis).map(r => {
        const box = r.closest('div')?.parentElement;
        return { id: r.id, group: r.name, question: __clean(r.getAttribute('aria-label')).slice(0,140),
                 option: __clean(box?.querySelector('p, span')?.textContent), checked: r.checked };
      });
      const btns = [...scope.querySelectorAll('button')].filter(__vis).map(b => ({ t: __clean(b.textContent), aria: b.getAttribute('aria-label')||'' }))
        .filter(b => /^(next|review|submit application|back|edit|dismiss)$/i.test(b.t));
      const pg = __clean(scope.querySelector('*')?.parentElement?.innerText || '').match(/(\\d)\\/(\\d) pages/)?.[0] || '';
      return { fields, radios, btns, pg };`);
    }
    log.push(`p${page} ${dump.pg}`);

    // ---- answer text fields
    for (const f of dump.fields) {
      if (f.value) continue; // pre-filled
      if (!f.label) continue;
      const r = await resolveAnswer(f.label, job.title);
      if (r.answer) {
        const fillRes = await evalIn(`
          const f = document.getElementById(${JSON.stringify(f.id)});
          if (!f) return false;
          const set = Object.getOwnPropertyDescriptor(f.constructor.prototype, 'value').set;
          set.call(f, ${JSON.stringify(String(r.answer))});
          f.dispatchEvent(new Event('input', {bubbles:true})); f.dispatchEvent(new Event('change', {bubbles:true}));
          return f.value;`);
        log.push(`  Q:"${f.label.slice(0, 50)}" -> "${r.answer}" (${r.source})`);
      } else log.push(`  UNANSWERED:"${f.label.slice(0, 50)}"`);
    }

    // ---- answer radio groups
    const groups = {};
    for (const r of dump.radios) (groups[r.group] = groups[r.group] || { question: r.question, options: [] }).options.push(r);
    for (const g of Object.values(groups)) {
      if (g.options.some(o => o.checked)) continue; // already answered
      const res = await resolveAnswer(g.question, job.title);
      const want = mapAnswerToOption(res.answer || '');
      if (want) {
        const hit = g.options.find(o => optionMatches(o.option, want));
        if (hit) {
          await evalIn(`{ const r = document.getElementById(${JSON.stringify(hit.id)}); if (r) r.click(); return r?.checked; }`);
          log.push(`  Q:"${g.question.slice(0, 50)}" -> ${res.answer} (opt "${hit.option}", ${res.source})`);
        }
      } else log.push(`  RADIO UNANSWERED:"${g.question.slice(0, 50)}"`);
    }

    // ---- advance
    const live = dump.btns.filter(b => !/back|edit/i.test(b.t));
    const submit = live.find(b => /submit application/i.test(b.t));
    const review = live.find(b => /^review$/i.test(b.t));
    const next = live.find(b => /^next$/i.test(b.t));

    if (submit) {
      if (!LIVE) { console.log('  DRY — stopping BEFORE submit ✋'); dryStopped = true; break; }
      await advanceClick(conn, `[...(__modal()||document.body).querySelectorAll('button')].filter(__vis).find(x => /submit application/i.test(__clean(x.textContent)))`);
      await sleep(4000);
      submitted = true;
      log.push('SUBMITTED ✅');
      break;
    }
    const choice = review || next;
    if (!choice) { log.push('no actionable button'); break; }
    const clicked = await advanceClick(conn, `[...(__modal()||document.body).querySelectorAll('button')].filter(__vis).find(x => __clean(x.textContent).toLowerCase().startsWith(${JSON.stringify(choice.t.toLowerCase())}))`);
    log.push(`  btn-> ${choice.t} (${clicked})`);
    await sleep(3200);
  }

  // verify (live only)
  let verified = false;
  if (submitted) {
    await call('Page.navigate', { url: job.url });
    await sleep(3500);
    const t = await evalIn(`return document.body.innerText.slice(0, 2500)`);
    verified = /application submitted|você se candidatou|applied/i.test(String(t));
    log.push(verified ? 'VERIFIED on job page' : 'NOT VERIFIED — check manually');
  }

  if (submitted && verified) markApplied(job.source, job.source_id, log.join(' | ').slice(0, 500));
  log.forEach(l => console.log('  ' + l));
  return { ok: submitted && verified, dryStopped, log };
}

// ---- main ----------------------------------------------------------------
const jobs = targets();
console.log(`targets: ${jobs.length} approved job(s) — mode ${LIVE ? 'LIVE (submitting)' : 'DRY (stop before submit)'}`);
const conn = await connect();
let applied = 0;
for (const j of jobs) {
  if (applied >= HOURLY_CAP) { console.log('hourly cap'); break; }
  const r = await applyOne(conn, j);
  if (r.ok) applied++;
  await sleep(4000 + Math.random() * 2000);
}
conn.ws.close();
console.log(`\ndone: ${applied} submitted (${LIVE ? 'LIVE' : 'DRY'}).`);
