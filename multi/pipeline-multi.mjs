// multi/pipeline-multi.mjs — MULTI-DESCRIPTION pipeline (NEW, 2026-10-25).
// Parallel implementation of the production pipeline. ONE description is
// active per run (operator decision): it drives the LinkedIn/InfoJobs/post
// search keywords, the hard gates, the LLM prompt and the thresholds.
// Only NEW rows (status='new') get scored — old verdicts are untouched.
//
// Production files (pipeline.mjs, score.mjs, scrape-liposts.mjs, config.mjs)
// are NOT modified; this imports their exported, read-only pieces.
//
//   node multi/pipeline-multi.mjs --desc=dados --limit=3 --db=F:/.../test.sqlite
//   node multi/pipeline-multi.mjs --desc=desenvolvedor                (real run)
//   node multi/pipeline-multi.mjs --score-only --limit=3              (no network)
//
// Flags: --db= | --desc=NAME | --limit=N (LLM call cap; 0 = uncapped)
//        --scrape=jobs|posts|both | --score-only | --no-enrich | --no-queue
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeBrowser, discover as liDiscover, enrich as liEnrich } from '../linkedin.mjs';
import { discover as ijDiscover, detail as ijDetail } from '../infojobs.mjs';
import { upsertJob, isNew, setDescription, autoQueue80, setSetting } from '../db.mjs';
import { PACING } from '../config.mjs';
import { openDb } from './open.mjs';
import { resolveDescription, listDescriptions } from './descriptions.mjs';
import { scorePendingDesc } from './score-multi.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, '..');
const arg = (n, d) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=').slice(1).join('=') : d; };
const flag = (n) => process.argv.includes('--' + n);

const DB = arg('db', './jobs.sqlite');
const LIMIT = Number(arg('limit', 0));
const SCRAPE = arg('scrape', 'both');
const SCORE_ONLY = flag('score-only');
const ENRICH = !flag('no-enrich');
const QUEUE = !flag('no-queue');
const ts = () => new Date().toISOString().slice(11, 19);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const db = openDb(DB);
const { name: descName, desc } = resolveDescription(db, arg('desc', null));
console.log(`[${ts()}] pipeline-multi db=${DB}`);
console.log(`  description: ${desc.name} (${desc.label || ''})`);
console.log(`  available: ${listDescriptions().map(d => d.name).join(', ')}`);
console.log(`  scrape=${SCORE_ONLY ? 'none (score-only)' : SCRAPE} llm-cap=${LIMIT || 'none'} queue=${QUEUE}`);

// ---- isolated posts chrome (9225) -------------------------------------------
async function ensurePostsChrome() {
  try { const r = await fetch('http://127.0.0.1:9225/json/version'); if (r.ok) return true; } catch { /* down */ }
  console.log(`[${ts()}] launching isolated posts chrome :9225`);
  spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HOOK, 'launch-liposts-chrome.ps1')],
        { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    try { const r = await fetch('http://127.0.0.1:9225/json/version'); if (r.ok) return true; } catch { /* wait */ }
  }
  throw new Error('posts chrome did not come up on :9225');
}

// ---- stage: discover --------------------------------------------------------
async function discover() {
  let inserted = 0, seen = 0;

  // posts first (uses the isolated chrome, never the job/apply lanes)
  if (SCRAPE === 'posts' || SCRAPE === 'both') {
    await ensurePostsChrome();
    console.log(`[${ts()}] STAGE 1a — posts discovery (${desc.postKeywords.length} keywords)`);
    await run(['node', path.join(HERE, 'scrape-posts-multi.mjs'), `--desc=${desc.name}`, `--db=${DB}`]);
  }
  if (SCRAPE === 'posts') return { inserted, seen, postsOnly: true };

  console.log(`[${ts()}] STAGE 1b — LinkedIn discovery (${desc.liQueries.length} queries)`);
  let liJobs = [];
  const { b, ctx } = await makeBrowser();
  try {
    const r = await liDiscover(ctx, desc.liQueries, desc.liFilters || {}, PACING.search);
    liJobs = r.jobs;
    console.log(`  ${r.requests} requests -> ${r.unique} unique LinkedIn jobs`);
  } finally { await b.close(); }

  console.log(`[${ts()}] STAGE 1c — InfoJobs discovery (${desc.ijQueries.length} queries)`);
  const ijR = await ijDiscover(desc.ijQueries, PACING.search);
  console.log(`  ${ijR.requests} requests -> ${ijR.unique} unique InfoJobs jobs`);

  for (const j of liJobs.concat(ijR.jobs)) {
    const fresh = isNew(db, j.source, j.source_id);
    upsertJob(db, j);
    if (fresh) inserted++; else seen++;
  }
  console.log(`  stored: ${inserted} NEW + ${seen} already-known`);
  return { inserted, seen, li: liJobs.length, ij: ijR.jobs.length };
}

// ---- stage: enrich (replicated from production doEnrich) --------------------
async function enrich(limit = 60) {
  const need = db.prepare(
    `SELECT source, source_id, url FROM jobs WHERE (description IS NULL OR length(description) < 100) AND url IS NOT NULL
     ORDER BY first_seen DESC LIMIT ?`).all(limit);
  const liIds = need.filter(n => n.source === 'linkedin').map(n => n.source_id);
  const ijJobs = need.filter(n => n.source === 'infojobs');
  console.log(`[${ts()}] STAGE 2 — enrich: ${liIds.length} LinkedIn + ${ijJobs.length} InfoJobs`);
  if (liIds.length) {
    const { b, ctx } = await makeBrowser();
    try {
      const details = await liEnrich(ctx, liIds, PACING.detail);
      let n = 0;
      for (const [id, d] of Object.entries(details)) {
        const patch = { description: d.description, criteria: d.criteria, apply_url: d.apply_url };
        if (d.title) patch.title = d.title;
        if (d.company) patch.company = d.company;
        if (d.location) patch.location = d.location;
        const cur = db.prepare('SELECT easy_apply FROM jobs WHERE source=? AND source_id=?').get('linkedin', id);
        if (cur && !cur.easy_apply && d.apply_url) patch.apply_method = 'offsite';
        setDescription(db, 'linkedin', id, patch); n++;
      }
      console.log(`  LinkedIn: ${n}/${liIds.length} descriptions captured`);
    } finally { await b.close(); }
  }
  let ijOk = 0;
  for (const j of ijJobs) {
    try {
      const d = await ijDetail({ url: j.url });
      setDescription(db, 'infojobs', j.source_id, {
        description: d.description, title: d.title, company: d.company, location: d.location, apply_method: 'infojobs_native',
      });
      ijOk++;
    } catch { /* skip */ }
    await sleep(PACING.detail);
  }
  console.log(`  InfoJobs: ${ijOk}/${ijJobs.length} descriptions captured`);
  return { li: liIds.length, ij: ijOk };
}

// ---- child process helper ---------------------------------------------------
function run(argv) {
  return new Promise((res, rej) => {
    const c = spawn(argv[0], argv.slice(1), { stdio: 'inherit', cwd: HOOK });
    c.on('exit', code => code === 0 ? res() : rej(new Error(`${argv[1]} exit ${code}`)));
    c.on('error', rej);
  });
}

// ---- main -------------------------------------------------------------------
const started = Date.now();
try {
  if (!SCORE_ONLY) {
    const d = await discover();
    if (ENRICH) await enrich();
    if (QUEUE) { const q = autoQueue80(db); console.log(`[${ts()}] autoQueue80: ${q} queued`); }
  }
  console.log(`[${ts()}] STAGE 3 — score (description=${desc.name}, cap=${LIMIT || 'none'})`);
  const counts = await scorePendingDesc(db, desc.name, LIMIT || Infinity);
  if (QUEUE) { const q = autoQueue80(db); console.log(`[${ts()}] autoQueue80 (post-score): ${q} queued`); }

  // provenance report: which description scored what
  const rows = db.prepare(
    `SELECT COALESCE(json_extract(llm_json,'$.description'),'(legacy)') d, recommendation, COUNT(*) n
     FROM jobs WHERE llm_json IS NOT NULL GROUP BY 1,2 ORDER BY 1,2`).all();
  console.log(`[${ts()}] verdicts by description:`);
  for (const r of rows) console.log(`  ${r.d.padEnd(16)} ${String(r.recommendation).padEnd(7)} ${r.n}`);
  console.log(`[${ts()}] DONE in ${((Date.now() - started) / 1000).toFixed(0)}s — ${JSON.stringify(counts)}`);
} finally {
  db.close();
}
