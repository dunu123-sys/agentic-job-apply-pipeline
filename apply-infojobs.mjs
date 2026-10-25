// apply-infojobs.mjs — InfoJobs ONE-CLICK apply walker (codified from the
// live-mapped procedure in INFOJOBS-APPLY-PROCEDURE.md).
//   node apply-infojobs.mjs            -> DRY: check each job's apply button, no clicks
//   node apply-infojobs.mjs --live     -> apply for real
//   node apply-infojobs.mjs --live --limit=4   -> top N of the queue
//   node apply-infojobs.mjs --live --only=<source_id>
// Drives the persistent ij-profile Chrome on CDP :9224 (headed, logged in).
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { resolveAnswer, norm } from './answers.mjs';
import fs from 'node:fs';

const PORT = process.env.CDP_PORT || '9224';
const BASE = 'http://127.0.0.1:' + PORT;
const DB = './jobs.sqlite';
const AUDIT = './apply-audit.log';
const LIVE = process.argv.includes('--live');
const LIMIT = parseInt((process.argv.find(a => a.startsWith('--limit=')) || '=5').split('=')[1]);
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '=').split('=')[1];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- CDP plumbing -----------------------------------------------------------
async function connect() {
  const list = await (await fetch(BASE + '/json/list')).json();
  const t = list.find(x => x.type === 'page' && /infojobs/.test(x.url))
        || list.find(x => x.type === 'page' && !/^chrome:/.test(x.url));
  if (!t) throw new Error('no infojobs tab');
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
  const evalIn = async (expr) => {
    const r = await call('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 250));
    return r.result.value;
  };
  const realClick = async (expr) => {
    const box = await evalIn(`{ const el = (${expr}); if (!el || !el.offsetParent) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }`);
    if (!box) return 'not-found';
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await sleep(120);
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await sleep(60);
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    return true;
  };
  return { ws, call, evalIn, realClick };
}

// ---- targets -----------------------------------------------------------------
function targets() {
  const db = new DatabaseSync(DB, { readOnly: true });
  const rows = db.prepare(`SELECT source_id, title, company, url, score FROM jobs
    WHERE source='infojobs' AND COALESCE(apply_status,'')='' AND COALESCE(outreach_status,'')=''
      AND COALESCE(apply_method,'')='infojobs_native' AND url IS NOT NULL
      AND (recommendation='APPLY' OR approved=1)
    ORDER BY score DESC LIMIT ?`).all(LIMIT);
  db.close();
  return rows.filter(r => !ONLY || r.source_id === ONLY);
}

function markApplied(source_id, note) {
  const db = new DatabaseSync(DB);
  db.prepare(`UPDATE jobs SET outreach_status='applied',
    outreach_channels=COALESCE(outreach_channels,'')||'infojobs-native;',
    outreach_at=?, apply_status='applied-infojobs-native' WHERE source='infojobs' AND source_id=?`)
    .run(new Date().toISOString(), source_id);
  db.close();
  fs.appendFileSync(AUDIT, `${new Date().toISOString()} ${LIVE ? 'LIVE' : 'DRY'} infojobs:${source_id} ${note}\n`);
}

// ---- the one-click flow (per INFOJOBS-APPLY-PROCEDURE.md §2) ------------------
const HERO_SEL = `[...document.querySelectorAll('a,button')].find(b => b.offsetParent !== null && /^CANDIDATAR-ME/i.test((b.textContent||'').trim()))`;

async function applyOne(conn, job) {
  const { evalIn, realClick, call } = conn;
  const log = [];
  console.log(`\n--- ${job.company.slice(0,25)} | ${job.title.slice(0,45)} (score ${job.score})`);

  await call('Page.navigate', { url: job.url });
  await sleep(4500);
  const st = await evalIn(`return { loginRedirect: location.href.includes('account/login') || location.href.includes('autenticacao'),
    alreadyApplied: /já se candidatou/i.test(document.body.innerText),
    hero: !!(${HERO_SEL}) };`);
  if (st.loginRedirect) { console.log('  SESSION DEAD — operator re-login needed'); return { ok: false, why: 'login' }; }
  if (st.alreadyApplied || !st.hero) {
    console.log(st.alreadyApplied ? '  already applied — marking' : '  no hero button (expired/external?) — skip');
    if (st.alreadyApplied) markApplied(job.source_id, 'already-applied');
    return { ok: st.alreadyApplied, why: st.alreadyApplied ? 'already' : 'no-hero' };
  }

  if (!LIVE) { console.log('  DRY — hero button present, stopping'); return { ok: true, dry: true }; }

  // FULL AUTOMATION: OS-level mouse click (passes the HUMAN/PerimeterX gate).
  // Restores the window first (minimized windows sink OS clicks), then
  // clicks the hero with real hardware-pipeline input.
  await new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command',
      `Add-Type @'
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
}
'@
$p = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -match 'InfoJobs|Vaga' } | Select-Object -First 1
if ($p) { [W]::ShowWindowAsync($p.MainWindowHandle, 9) | Out-Null; Start-Sleep -Milliseconds 600; [W]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; 'restored' } else { 'no-window' }`],
      { timeout: 15000 }, () => resolve());
  });
  await sleep(600);
  const osClick = await new Promise((resolve) => {
    execFile('C:/Program Files/nodejs/node.exe',
      ['./os-click.mjs', HERO_SEL],
      { timeout: 45000, env: { ...process.env, CDP_PORT: PORT } },
      (e, stdout) => resolve(String(stdout).slice(0, 300)));
  });
  log.push('os-click: ' + osClick.replace(/\n/g, ' ').slice(0, 200));
  await sleep(3500);

  // ---- killer questions (if the job has them) --------------------------------
  const kq = await evalIn(`return !!([...document.querySelectorAll('div')].find(d => d.offsetParent !== null && /Para concluir a candidatura/i.test(d.textContent || '') && d.textContent.length < 3000));`);
  if (kq) {
    log.push('killer-questions OPEN — resolving');
    const dump = await evalIn(`
      const panel = [...document.querySelectorAll('div')].find(d => d.offsetParent !== null && /Para concluir a candidatura/i.test(d.textContent || '') && d.textContent.length < 4000);
      if (!panel) return null;
      // DOM-ORDER association: every question element (own text has '?'),
      // every input; an input's question = the LAST question preceding it.
      const qs = []; const seen = new Set();
      for (const el of panel.querySelectorAll('p, span, label, div')) {
        if (el.offsetParent === null) continue;
        const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
        if (own.length < 8 || !own.includes('?') || seen.has(own)) continue;
        seen.add(own);
        qs.push({ el, text: own.slice(0, 140) });
      }
      const qFor = (inputEl) => {
        let best = '';
        for (const q of qs) {
          if (q.el.compareDocumentPosition(inputEl) & Node.DOCUMENT_POSITION_FOLLOWING) best = q.text;
        }
        return best;
      };
      const radios = [...panel.querySelectorAll('input[type=radio]')].filter(r => r.offsetParent !== null).map(r => ({
        id: r.id, group: r.name, value: r.value, question: qFor(r) }));
      const tas = [...panel.querySelectorAll('textarea')].filter(t => t.offsetParent !== null).map(t => ({
        id: t.id, question: qFor(t) }));
      return { radios, tas };`);
    if (dump) {
      const groups = {};
      for (const r of dump.radios || []) (groups[r.group] = groups[r.group] || { q: r.question, opts: [] }).opts.push(r);
      for (const g of Object.values(groups)) {
        let res = await resolveAnswer(g.q, job.title);
        let a = norm(res.answer || '');
        let want = /^(sim|yes|s)/.test(a) ? 'Sim' : (/^(nao|no|n)/.test(a) ? 'Não' : null);
        // fallback: yes/no-shaped question but the answer didn't map (e.g. bank
        // returned "6 anos" for a "possui experiência com X?" form) -> force
        // a Sim/Não answer from the LLM.
        if (!want && /possui|tem |trabalhou|disponib|experi[eê]ncia (com|no|profissional)/i.test(g.q || '')) {
          res = await resolveAnswer(g.q + ' (responda APENAS Sim ou Não)', job.title);
          a = norm(res.answer || '');
          want = /^(sim|yes|s)/.test(a) ? 'Sim' : (/^(nao|no|n)/.test(a) ? 'Não' : null);
        }
        if (want) {
          const hit = g.opts.find(o => {
            const isSim = /^sim$/i.test(o.value);
            const isNao = /^n(ã|a)o$/i.test(o.value);
            return want === 'Sim' ? isSim : isNao;
          });
          if (hit) { await evalIn(`document.getElementById(${JSON.stringify(hit.id)}).click(); return true;`); log.push(`  Q: "${g.q.slice(0, 45)}" -> ${want} (${res.source})`); }
          else log.push(`  RADIO no option for "${res.answer}"`);
        } else log.push(`  RADIO unresolved: "${g.q.slice(0, 40)}"`);
      }
      for (const t of dump.tas || []) {
        const res = await resolveAnswer(t.question, job.title);
        if (res.answer) {
          await evalIn(`{ const f = document.getElementById(${JSON.stringify(t.id)}); const set = Object.getOwnPropertyDescriptor(f.constructor.prototype, 'value').set; set.call(f, ${JSON.stringify(String(res.answer))}); f.dispatchEvent(new Event('input', { bubbles: true })); f.dispatchEvent(new Event('change', { bubbles: true })); return f.value.length; }`);
          log.push(`  Q: "${(t.question || 'open question').slice(0, 40)}" -> "${String(res.answer).slice(0, 40)}" (${res.source})`);
        } else log.push(`  OPEN unresolved: "${(t.question || '').slice(0, 40)}"`);
      }
      // submit CONCLUIR CANDIDATURA (synthetic works — never gated)
      const submitDone = await realClick(`document.getElementById('btnKillerQuestionsAccept')`);
      log.push('concluir: ' + submitDone);
      await sleep(4500);
    }
  }

  // success modal check
  const after = await evalIn(`return { modal: (([...document.querySelectorAll('.modal')].find(x => getComputedStyle(x).display === 'block')||{}).innerText || '').replace(/\\s+/g, ' ').slice(0, 150) };`);
  const confirmed = /Você se candidatou à vaga/i.test(after.modal);
  log.push('modal: ' + (confirmed ? 'CONFIRMED ✅' : JSON.stringify(after.modal).slice(0, 80)));

  // close the upsell (X always works; "Agora não" sometimes unreachable)
  if (after.modal) {
    await evalIn(`{ const m=[...document.querySelectorAll('.modal')].find(x => getComputedStyle(x).display === 'block');
      if (m) { const x=m.querySelector('[data-dismiss], button.close, a.close') || m.querySelector('button');
        if (x) { x.click(); return 'closed'; } } return 'no-modal'; }`);
    await sleep(1500);
  }

  // verify: modal confirm OR hero gone - and if BOTH look negative, the click
  // may STILL have applied (InfoJobs modals are unreliable: sometimes empty or
  // a 'Receba vagas similares' popup). RELOAD the page and check for the
  // authoritative applied state before declaring failure.
  let gone = await evalIn(`return !(${HERO_SEL});`);
  log.push('heroGone: ' + gone);
  let ok = confirmed || gone;
  if (!ok) {
    await call('Page.navigate', { url: job.url });
    await sleep(4000);
    const recheck = await evalIn(`return { jaCandidatou: /j\\u00e1 se candidatou|voce se candidatou/i.test(document.body.innerText), heroGone: !(${HERO_SEL}) };`);
    ok = recheck.jaCandidatou || recheck.heroGone;
    log.push('recheck-after-reload: ' + JSON.stringify(recheck) + (ok ? ' => APPLIED' : ' => failed'));
  }
  if (ok) markApplied(job.source_id, log.join(' | ').slice(0, 400));
  log.forEach(l => console.log('  ' + l));
  return { ok };
}

// ---- main ------------------------------------------------------------------
const jobs = targets();
console.log(`InfoJobs queue: ${jobs.length} job(s) — mode ${LIVE ? 'LIVE (applying)' : 'DRY (no clicks)'}`);
const conn = await connect();
let applied = 0;
for (const j of jobs) {
  const r = await applyOne(conn, j);
  if (r.ok) applied++;
  await sleep(5000 + Math.random() * 2000);
}
conn.ws.close();
console.log(`\ndone: ${applied}/${jobs.length} ${LIVE ? 'applied' : 'dry-checked'}.`);
