// multi/scrape-posts-multi.mjs — posts scraper with DESCRIPTION keywords (NEW).
// Fork of the production scrape-liposts.mjs (unchanged there) whose only
// difference is where the keyword list comes from:
//
//   node multi/scrape-posts-multi.mjs --desc=dados --db=F:/.../test.sqlite
//   node multi/scrape-posts-multi.mjs --kws="vaga power bi,vaga dados"
//
// Same DOM contract, same 3 patient passes, same no-scroll rule (recon
// POSTS-JOBS-RECON.md), same isolated :9225 chrome. Provenance tag
// 'liposts:<description>:<kw>' is stored in found_by.
import { upsertJob, isNew, setDescription } from '../db.mjs';
import { openDb } from './open.mjs';
import { loadDescription } from './descriptions.mjs';

const PORT = process.env.CDP_PORT || '9225';
const BASE = 'http://127.0.0.1:' + PORT;
const arg = (n, d) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=').slice(1).join('=') : d; };
const DB = arg('db', './jobs.sqlite');

const PASSES = 3;
const PASS_WAITS = [9000, 12000, 15000];
const MAX_POSTS = 60;
const MIN_TEXT = 220;
const JOB_RX = /(vaga|oportunidade|contratando|we are hiring|hiring|job opening|#vagas|#oportunidade|candidate-se|candidatar)/i;
const LINK_HINTS = ['jobs/view', 'infojobs', 'greenhouse', 'lever.co', 'forms.', 'bit.ly'];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function pageTarget() {
  const list = await (await fetch(BASE + '/json/list')).json();
  return list.find(x => x.type === 'page' && /linkedin\.com/.test(x.url)) || list.find(x => x.type === 'page');
}
async function connect() {
  const t = await pageTarget();
  if (!t) throw new Error('no chrome tab on CDP :' + PORT + ' — run launch-liposts-chrome.ps1');
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
  await call('Runtime.enable'); await call('Page.enable');
  const evalIn = (expr) => call('Runtime.evaluate', { expression: expr, returnByValue: true }).then(r => r.result.value);
  return { ws, call, evalIn };
}

const EXTRACT = `(() => {
  const units = document.querySelectorAll('div[role="listitem"]');
  const out = [];
  units.forEach(u => {
    const ck = u.getAttribute('componentkey') || (u.querySelector('[componentkey^="update-card-focus"]')?.getAttribute('componentkey') || '');
    const m = ck.match(/^update-card-focus(.+)FeedType_FLAGSHIP_SEARCH$/);
    if (!m) return;
    const authorLink = u.querySelector('a[href*="/company/"], a[href*="/in/"]');
    let author = '';
    const alt = u.querySelector('img[alt^="View company:"]')?.alt || '';
    if (alt) author = alt.replace(/^View company:\\s*/i, '').trim();
    if (!author) { const al = u.querySelector('div[aria-label]'); if (al && al.getAttribute('aria-label')) author = al.getAttribute('aria-label').trim(); }
    if (!author) { const p = u.querySelector('p span'); if (p) author = (p.textContent || '').trim(); }
    let text = u.innerText || '';
    const likeIdx = text.indexOf('\\nLike\\n');
    if (likeIdx > 0) text = text.slice(0, likeIdx);
    text = text.replace(/\\s*\\n\\s*/g, '\\n').trim();
    const links = [];
    u.querySelectorAll('a[href]').forEach(a => {
      const t = (a.innerText || '').trim();
      const h = a.href.split('?')[0];
      if (!t) return;
      if (h.includes('linkedin.com/feed')) return;
      if (h.includes('/company/') || h.includes('/school/')) return;
      if (/^https:\\/\\/(www\\.)?linkedin\\.com\\/in\\/[^/]+\\/?$/.test(h)) return;
      if (h.includes('help.linkedin') || h.includes('linkedin.com/policies')) return;
      links.push({ h, t: t.slice(0, 120) });
    });
    out.push({ token: m[1], author, authorHref: authorLink ? authorLink.href : '', text, links });
  });
  return out;
})()`;

// ---- keyword resolution: --kws > --desc file > error ------------------------
const kwArg = arg('kws', '');
const descName = arg('desc', '');
let kws, tag;
if (kwArg) { kws = kwArg.split(',').map(s => s.trim()).filter(Boolean); tag = 'custom'; }
else {
  const desc = loadDescription(descName || 'desenvolvedor');
  kws = desc.postKeywords; tag = desc.name;
}
console.log(`[scrape-posts-multi] description=${tag} keywords=${kws.length} db=${DB}`);

const db = openDb(DB);
const { ws, call, evalIn } = await connect();

let totalNew = 0, totalSeen = 0, totalJobs = 0;
for (const kw of kws) {
  const url = 'https://www.linkedin.com/search/results/content/?keywords=' + encodeURIComponent(kw) +
              '&origin=GLOBAL_SEARCH_HEADER&sortBy=%22date_posted%22';
  await call('Page.navigate', { url });
  const seen = new Map();
  for (let s = 0; s < PASSES; s++) {
    await sleep(PASS_WAITS[s] || 10000);
    const batch = await evalIn(EXTRACT).catch(() => []);
    batch.forEach(p => seen.set(p.token, p));
    if (seen.size >= MAX_POSTS) break;
  }
  const posts = Array.from(seen.values());
  console.log(`[kw="${kw}"] posts seen: ${posts.length}`);
  totalSeen += posts.length;

  let newCt = 0, jobCt = 0;
  for (const p of posts) {
    const jobLike = JOB_RX.test(p.text) || p.links.some(l => LINK_HINTS.some(s => l.h.includes(s)));
    if (!jobLike) continue;
    jobCt++;
    if (p.text.length < MIN_TEXT) { console.log(`  thin post skipped (${p.text.length} ch): ${p.author || '?'}`); continue; }
    if (!p.token || !p.text) continue;
    const noise = /^(feed post|follow|join|like|comment|repost|share|•|\d+\s*(h|m|d|w|s)\b|\d+\s*(reactions?|comments?)|\d+\/\d+|page \d+)/i;
    const firstLine = (p.text.split('\n').find(l => {
      const t = l.trim();
      return t.length > 25 && !noise.test(t) && (!p.author || !t.startsWith(p.author.slice(0, 12)));
    }) || ((p.author || 'LinkedIn') + ' — post')).trim().slice(0, 120);
    const bestLink = (p.links.find(l => LINK_HINTS.some(s => l.h.includes(s))) || p.links[0] || {}).h || p.authorHref || '';
    const rec = {
      source: 'lipost', source_id: p.token, url: bestLink,
      title: firstLine, company: p.author || '(unknown author)', location: 'Brasil',
      easy_apply: 0, apply_method: 'post-link',
      found_by: ['liposts:' + tag + ':' + kw],
    };
    const fresh = isNew(db, 'lipost', p.token);
    upsertJob(db, rec);
    setDescription(db, 'lipost', p.token, { description: p.text.slice(0, 6000), posted_date: null });
    if (fresh) newCt++;
  }
  totalJobs += jobCt; totalNew += newCt;
  console.log(`  job-like: ${jobCt}, NEW rows: ${newCt}`);
  await sleep(1500);
}

console.log(`DONE liposts[${tag}]: seen=${totalSeen} job-like=${totalJobs} new=${totalNew}`);
const pend = db.prepare("SELECT COUNT(*) n FROM jobs WHERE source='lipost' AND status='new'").get();
console.log(`lipost rows pending score: ${pend.n}`);
ws.close();
db.close();
