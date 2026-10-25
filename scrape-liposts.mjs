// scrape-liposts.mjs — LinkedIn FEED-POSTS job source (NEW, 2026-10-24).
// Scrapes LinkedIn content search for job-like posts (recruiter #vagas posts),
// stores them as source='lipost' rows in jobs.sqlite. The EXISTING pipeline is
// NOT modified: these rows flow into scoring/reporting via the same generic
// pendingScore/saveScore path (source-agnostic by design).
//
// DOM contract (recon 2026-10-24, POSTS-JOBS-RECON.md):
//   - post unit   : div[role="listitem"] with componentkey
//                   "update-card-focus<TOKEN>FeedType_FLAGSHIP_SEARCH"
//                   (TOKEN = unique per post -> our source_id; classes are
//                   obfuscated l4j*, DO NOT anchor on them)
//   - author      : first a[href*="/company/"|"/in/"] inside the unit; name from
//                   img[alt^="View company:"] / div[aria-label] / first p>span
//   - text        : unit.innerText, cut at the "Like" social-actions line
//   - links       : all a[href] with text, minus feed/nav noise
//
//   node scrape-liposts.mjs                    -> default keyword set
//   node scrape-liposts.mjs --kw="vaga c#"     -> one custom keyword
//
// Needs: li-profile Chrome on CDP :9223 (logged in).

import { open, upsertJob, isNew, setDescription } from './db.mjs';
import { resolveDescription } from './descriptions.mjs';

// ISOLATED instance (operator rule 2026-10-25): dedicated chrome on :9225
// with the cloned li-profile-posts + --disable-gpu. Other lanes' chromes
// (apply runners on :9223/:9224) are NEVER touched. Launch:
//   powershell -File launch-liposts-chrome.ps1   (close: close-liposts-chrome.ps1)
const PORT = process.env.CDP_PORT || '9225';
const BASE = 'http://127.0.0.1:' + PORT;
const DB = './jobs.sqlite';
// RECON FACT (2026-10-25, rounds 9-11): each content search page-load renders
// exactly 3 posts and NOTHING changes that (no scroll, no pagination, viewport
// override ignored, no lazy growth over 3 min). Yield lever = keyword count.
// MULTI-DESCRIPTION (2026-10-25): keywords now come from the ACTIVE description
// (descriptions/<name>.json -> postKeywords). Resolution: --kw= > --kws=a,b >
// --desc=NAME > settings.active_description > 'desenvolvedor'.
// RECON FACT (2026-10-24): the content search loads ~9 posts per page-load and
// IGNORES &page=N; scrolling/wheel events wedge the Renaissance scroller.
// So: NO scrolling — one page per keyword, two extraction passes, more
// keywords. ~9 fresh posts x 6 keywords, dedupe by token.
// RECON (round 12): keyboard/wheel/viewport tricks all fail to extend the
// list (nothing scrolls - the list IS the viewport). But lazy batches vary
// 3-24 per load -> 3 patient passes catch the bigger renders.
const PASSES = 3;            // extraction passes per keyword (lazy render)
const PASS_WAITS = [9000, 12000, 15000]; // settle before each pass
const MAX_POSTS = 60;        // hard cap per keyword
const MIN_TEXT = 220;         // pendingScore requires description > 200 chars
const JOB_RX = /(vaga|oportunidade|contratando|we are hiring|hiring|job opening|#vagas|#oportunidade|candidate-se|candidatar)/i;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function pageTarget() {
  const list = await (await fetch(BASE + '/json/list')).json();
  // fresh launch = only chrome:// welcome tabs; grab the first page tab and
  // navigate it via CDP (never PUT /json/new - it kills chrome)
  return list.find(x => x.type === 'page' && /linkedin\.com/.test(x.url))
      || list.find(x => x.type === 'page');
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
    // author
    const authorLink = u.querySelector('a[href*="/company/"], a[href*="/in/"]');
    let author = '';
    const alt = u.querySelector('img[alt^="View company:"]')?.alt || '';
    if (alt) author = alt.replace(/^View company:\\s*/i, '').trim();
    if (!author) { const al = u.querySelector('div[aria-label]'); if (al && al.getAttribute('aria-label')) author = al.getAttribute('aria-label').trim(); }
    if (!author) { const p = u.querySelector('p span'); if (p) author = (p.textContent || '').trim(); }
    // text: full unit text, cut at the social "Like" block
    let text = u.innerText || '';
    const likeIdx = text.indexOf('\\nLike\\n');
    if (likeIdx > 0) text = text.slice(0, likeIdx);
    text = text.replace(/\\s*\\n\\s*/g, '\\n').trim();
    // links worth keeping
    const links = [];
    u.querySelectorAll('a[href]').forEach(a => {
      const t = (a.innerText || '').trim();
      const h = a.href.split('?')[0];
      if (!t || !h || h.includes('linkedin.com/feed') || h.includes('/company/') || h.includes('/in/') && !h.includes('/in/') === false) { /* keep */ }
      if (!t) return;
      if (h.includes('linkedin.com/feed/update') || h.includes('linkedin.com/feed/')) return;
      if (h.includes('/company/') || h.includes('/school/')) return;
      if (/^https:\\/\\/(www\\.)?linkedin\\.com\\/in\\/[^/]+\\/?$/.test(h)) return;
      if (h.includes('help.linkedin') || h.includes('linkedin.com/policies')) return;
      links.push({ h, t: t.slice(0, 120) });
    });
    out.push({ token: m[1], author, authorHref: authorLink ? authorLink.href : '', text, links });
  });
  return out;
})()`;

// ---- main ----
const kwArg = (process.argv.find(a => a.startsWith('--kw=')) || '').slice(5);
const kwsArg = (process.argv.find(a => a.startsWith('--kws=')) || '').slice(6);
const descArg = (process.argv.find(a => a.startsWith('--desc=')) || '').slice(7);
const db = open(DB);
let kws, descName = 'custom';
if (kwArg) kws = [kwArg];
else if (kwsArg) kws = kwsArg.split(',').map(s => s.trim()).filter(Boolean);
else {
  const { desc } = resolveDescription(db, descArg || null);
  descName = desc.name;
  kws = desc.postKeywords;
}
console.log(`[liposts] description=${descName} keywords=${kws.length}`);
const { ws, call, evalIn } = await connect();

let totalNew = 0, totalSeen = 0, totalJobs = 0;
for (const kw of kws) {
  const url = 'https://www.linkedin.com/search/results/content/?keywords=' + encodeURIComponent(kw) +
              '&origin=GLOBAL_SEARCH_HEADER&sortBy=%22date_posted%22';
  await call('Page.navigate', { url });
  // lazy render: patient extraction passes, no scrolling (recon rounds 9-12)
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
    const jobLike = JOB_RX.test(p.text) || p.links.some(l => ['jobs/view','infojobs','greenhouse','lever.co','forms.','bit.ly'].some(s => l.h.includes(s)));
    if (!jobLike) continue;
    jobCt++;
    if (p.text.length < MIN_TEXT) {
      console.log(`  thin post skipped (${p.text.length} ch): ${p.author || '?'} — ${(p.text.split('\\n')[0] || '').slice(0, 60)}`);
      continue;
    }
    if (!p.token || !p.text) continue;
    const noise = /^(feed post|follow|join|like|comment|repost|share|\u2022|\d+\s*(h|m|d|w|s)\b|\d+\s*(reactions?|comments?)|\d+\/\d+|page \d+)/i;
    const firstLine = (p.text.split('\n').find(l => {
      const t = l.trim();
      return t.length > 25 && !noise.test(t) && (!p.author || !t.startsWith(p.author.slice(0, 12)));
    }) || ((p.author || 'LinkedIn') + ' — post')).trim().slice(0, 120);
    const bestLink = (p.links.find(l => ['jobs/view','infojobs','greenhouse','lever.co','forms.','bit.ly'].some(s => l.h.includes(s))) || p.links[0] || {}).h || p.authorHref || '';
    const rec = {
      source: 'lipost', source_id: p.token, url: bestLink,
      title: firstLine, company: p.author || '(unknown author)', location: 'Brasil',
      easy_apply: 0, apply_method: 'post-link',
      found_by: ['liposts:' + descName + ':' + kw]
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

console.log(`DONE liposts: seen=${totalSeen} job-like=${totalJobs} new=${totalNew}`);
const pend = db.prepare("SELECT COUNT(*) n FROM jobs WHERE source='lipost' AND status='new'").get();
console.log(`lipost rows pending score: ${pend.n}`);
ws.close();
db.close();
