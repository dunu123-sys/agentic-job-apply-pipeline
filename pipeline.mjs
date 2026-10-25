// Pipeline orchestrator — Discover -> Store -> Enrich -> Score -> Report.
// Usage:
//   node pipeline.mjs discover   (stages 1-2: search both sources, store new jobs)
//   node pipeline.mjs enrich      (stage 3: fetch descriptions for jobs that lack one)
//   node pipeline.mjs score       (stage 4: rubric verdicts)
//   node pipeline.mjs all         (everything, in order)
//   node pipeline.mjs report      (read-only summary of the DB)

import { spawn } from 'node:child_process';
import { open, upsertJob, isNew, setDescription, pendingScore, saveScore, stats, autoQueue80, getSetting } from './db.mjs';
import { PACING } from './config.mjs';
import { resolveDescription } from './descriptions.mjs';
import * as li from './linkedin.mjs';
import * as ij from './infojobs.mjs';
import { llmKey, verdict } from './score.mjs';
import * as progress from './progress.mjs';

// --scrape=jobs|posts|both (operator rule 2026-10-25: posts are a first-class
// source in the MAIN pipeline now; production has NO LLM call cap)
const SCRAPE = (() => { const a = process.argv.find(x => x.startsWith('--scrape=')); return a ? a.split('=')[1] : 'both'; })();
if (!['jobs', 'posts', 'both'].includes(SCRAPE)) { console.error('bad --scrape= value'); process.exit(1); }

// --desc=NAME (operator rule 2026-10-25): ONE target-role description per run.
// Explicit flag > settings.active_description > 'desenvolvedor'. The description
// drives search keywords, hard gates, the LLM prompt and the thresholds.
const DESC_ARG = (() => { const a = process.argv.find(x => x.startsWith('--desc=')); return a ? a.split('=')[1] : null; })();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);

// posts source: ensure the ISOLATED liposts chrome (:9225) is up, then run
// the post-search scraper (16 stack keywords, NEW source per POSTS-JOBS-RECON.md)
async function ensureLipostsChrome() {
  try { await (await fetch('http://127.0.0.1:9225/json/version', { signal: AbortSignal.timeout(3000) })).json(); return true; } catch {}
  console.log('  launching isolated liposts chrome (:9225, PID-tracked)');
  spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', './launch-liposts-chrome.ps1'], { stdio: 'ignore', detached: true }).unref();
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try { await (await fetch('http://127.0.0.1:9225/json/version', { signal: AbortSignal.timeout(3000) })).json(); return true; } catch {}
  }
  throw new Error('liposts chrome did not come up on :9225');
}
async function doDiscoverPosts(db, desc) {
  progress.stage('discover', 'LinkedIn posts search');
  console.log(`[${ts()}] STAGE 1 — LinkedIn POSTS discovery (${desc.postKeywords.length} keywords, description=${desc.name})`);
  await ensureLipostsChrome();
  await new Promise((res, rej) => {
    const p = spawn('node', ['scrape-liposts.mjs', `--desc=${desc.name}`], { cwd: '.', stdio: 'inherit' });
    p.on('exit', c => c === 0 ? res() : rej(new Error('liposts scrape exit ' + c)));
  });
  const n = db.prepare(`SELECT COUNT(*) n FROM jobs WHERE source='lipost' AND status='new'`).get().n;
  console.log(`  lipost rows pending score: ${n}`);
  progress.counts({ lipost_pending: n });
  return n;
}

async function doDiscover(db, desc) {
  if (SCRAPE === 'posts') { await doDiscoverPosts(db, desc); return { inserted: 0, seen: 0, li: 0, ij: 0, posts: true }; }
  let liJobs = [], ijR = { jobs: [] };
  if (SCRAPE === 'both') await doDiscoverPosts(db, desc);

  progress.stage('discover', 'LinkedIn search');
  console.log(`[${ts()}] STAGE 1 — LinkedIn discovery (${desc.liQueries.length} queries, description=${desc.name})`);
  const { b, ctx } = await li.makeBrowser();
  try {
    const r = await li.discover(ctx, desc.liQueries, desc.liFilters || {}, PACING.search);
    liJobs = r.jobs;
    console.log(`  ${r.requests} requests -> ${r.unique} unique LinkedIn jobs`);
    progress.counts({ linkedin_found: r.unique });
  } finally { await b.close(); }

  progress.stage('discover', 'InfoJobs search');
  console.log(`[${ts()}] STAGE 1 — InfoJobs discovery`);
  ijR = await ij.discover(desc.ijQueries, PACING.search);
  console.log(`  ${ijR.requests} requests -> ${ijR.unique} unique InfoJobs jobs`);
  progress.counts({ infojobs_found: ijR.unique });

  let inserted = 0, seen = 0, liNew = 0, ijNew = 0;
  for (const j of liJobs.concat(ijR.jobs)) {
    const fresh = isNew(db, j.source, j.source_id);
    upsertJob(db, j);
    if (fresh) { inserted++; if (j.source === 'linkedin') liNew++; else ijNew++; } else seen++;
  }
  console.log(`  stored: ${inserted} NEW + ${seen} already-known`);
  progress.counts({ discovered: liJobs.length + ijR.jobs.length, inserted, known: seen, linkedin_new: liNew, infojobs_new: ijNew });
  return { inserted, seen, li: liJobs.length, ij: ijR.jobs.length };
}

async function doEnrich(db, limit = 60) {
  progress.stage('enrich', 'fetching job descriptions');
  // jobs with no description yet, newest first
  const need = db.prepare(
    `SELECT source, source_id, url FROM jobs WHERE (description IS NULL OR length(description) < 100) AND url IS NOT NULL
     ORDER BY first_seen DESC LIMIT ?`).all(limit);
  const liIds = need.filter(n => n.source === 'linkedin').map(n => n.source_id);
  const ijJobs = need.filter(n => n.source === 'infojobs');
  console.log(`[${ts()}] STAGE 3 — enrich: ${liIds.length} LinkedIn + ${ijJobs.length} InfoJobs`);
  progress.counts({ to_enrich: need.length });

  let enriched = 0;
  if (liIds.length) {
    const { b, ctx } = await li.makeBrowser();
    try {
      const details = await li.enrich(ctx, liIds, PACING.detail);
      let n = 0;
      for (const [id, d] of Object.entries(details)) {
        const job = need.find(x => x.source === 'linkedin' && x.source_id === id);
        if (!job) continue;
        const patch = { description: d.description, criteria: d.criteria, apply_url: d.apply_url };
        if (d.title) patch.title = d.title;
        if (d.company) patch.company = d.company;
        if (d.location) patch.location = d.location;
        // if the job is NOT in the easy-apply set and we found an offsite URL -> method known
        const cur = db.prepare('SELECT easy_apply FROM jobs WHERE source=? AND source_id=?').get('linkedin', id);
        if (cur && !cur.easy_apply && d.apply_url) patch.apply_method = 'offsite';
        setDescription(db, 'linkedin', id, patch);
        n++;
      }
      enriched += n;
      console.log(`  LinkedIn: ${n}/${liIds.length} descriptions captured`);
      progress.counts({ enriched, enrich_detail: `LinkedIn ${n}/${liIds.length}` });
    } finally { await b.close(); }
  }

  let ijOk = 0;
  for (const j of ijJobs) {
    try {
      const d = await ij.detail({ url: j.url });
      setDescription(db, 'infojobs', j.source_id, {
        description: d.description, title: d.title, company: d.company, location: d.location, apply_method: 'infojobs_native',
      });
      ijOk++;
    } catch (e) { /* skip */ }
    await sleep(PACING.detail);
  }
  enriched += ijOk;
  if (ijJobs.length) console.log(`  InfoJobs: ${ijOk}/${ijJobs.length} descriptions captured`);
  progress.counts({ enriched, enrich_detail: `InfoJobs ${ijOk}/${ijJobs.length}` });
}

async function doScore(db, desc, limit = 150) {
  // combo is operator-configurable via the CONFIG tab (settings table); the
  // last-resort fallback stays from config.mjs so a broken combo can't kill scoring
  const combo = getSetting(db, 'score_combo', 'default');
  const LLM = (await import('./config.mjs')).LLM;
  const fallback = LLM.models[LLM.models.length - 1];
  const models = [combo, combo, fallback];
  progress.stage('score', `scoring with ${combo} (${desc.name})`);
  const jobs = pendingScore(db, limit);
  console.log(`[${ts()}] STAGE 4 — scoring ${jobs.length} jobs (combo: ${combo}, description: ${desc.name})`);
  const key = llmKey();
  if (!key) throw new Error('no LLM API key configured');
  const CALL_TIMEOUT = 360_000; // operator rule 2026-10-25: models can be slow;
  let timeouts = 0, timedOut = false; // a hung call must never wedge the run
  let counts = { APPLY: 0, REVIEW: 0, SKIP: 0 };
  let i = 0;
  for (const job of jobs) {
    i++;
    if (timeouts >= 2) { console.log('  the router looks stuck (2 timeouts) - aborting score stage; rest stays pending'); timedOut = true; break; }
    let v;
    try {
      v = await Promise.race([
        verdict(job, key, models, desc),
        new Promise((_, rej) => setTimeout(() => rej(new Error('llm-timeout-360s')), CALL_TIMEOUT)),
      ]);
    } catch (e) {
      timeouts++;
      console.log(`  TIMEOUT ${e.message} | ${(job.title || '').slice(0, 50)} - row stays pending`);
      continue;
    }
    saveScore(db, job.source, job.source_id, v);
    if (counts[v.recommendation] !== undefined) counts[v.recommendation]++;
    if (i % 10 === 0) {
      console.log(`  ${i}/${jobs.length} scored (${JSON.stringify(counts)})`);
      progress.counts({ scored: (progress.readState()?.counts?.scored || 0) + 10, apply: counts.APPLY, review: counts.REVIEW, skip: counts.SKIP, score_detail: `${i}/${jobs.length}` });
    }
    await sleep(PACING.score);
  }
  console.log(`  done: ${JSON.stringify(counts)}${timeouts ? ` (timeouts: ${timeouts})` : ''}`);
  if (timedOut) { db.close(); process.exit(0); } // a hung promise may linger; exit hard
  progress.counts({ scored: (progress.readState()?.counts?.scored || 0) + (i % 10), apply: counts.APPLY, review: counts.REVIEW, skip: counts.SKIP, score_detail: `${i}/${jobs.length}` });
  // AUTO-QUEUE (operator rule 2026-10-23): score>=80 + (EA | infojobs_native)
  // -> straight into the apply queue, no manual approval needed
  const queued = autoQueue80(db);
  if (queued) console.log(`  auto-queued ${queued} job(s) (score>=80, EA/InfoJobs) into the apply list`);
  return counts;
}

function doReport(db) {
  const s = stats(db);
  console.log(JSON.stringify(s, null, 1));
  console.log('\n--- top APPLY ---');
  for (const r of db.prepare(
    `SELECT source, title, company, location, score, easy_apply, substr(description,1,80) d
     FROM jobs WHERE recommendation='APPLY' ORDER BY score DESC LIMIT 10`).all())
    console.log(` [${r.score}] ${r.title} @ ${r.company} (${r.location}) EA=${r.easy_apply} src=${r.source}\n      ${r.d}...`);
  console.log('\n--- verdict spread (all scored) ---');
  for (const r of db.prepare(
    `SELECT recommendation, COUNT(*) n, ROUND(AVG(score),1) avg FROM jobs WHERE status='scored' GROUP BY recommendation`).all())
    console.log(`  ${r.recommendation}: ${r.n} (avg ${r.avg})`);
  console.log('\n--- gate failures (top reasons) ---');
  for (const r of db.prepare(
    `SELECT substr(gate_fail,1,60) g, COUNT(*) n FROM jobs WHERE gate_fail IS NOT NULL GROUP BY g ORDER BY n DESC LIMIT 6`).all())
    console.log(`  ${r.n}x ${r.g}`);
}

const cmd = process.argv[2] || 'report';
if (cmd !== 'report') progress.start();
const db = open();
const { desc } = resolveDescription(db, DESC_ARG);
if (cmd !== 'report') console.log(`[${ts()}] description: ${desc.name} (${desc.label || ''})`);
try {
  if (cmd === 'discover') await doDiscover(db, desc);
  else if (cmd === 'enrich') await doEnrich(db);
  else if (cmd === 'score') await doScore(db, desc);
  else if (cmd === 'report') doReport(db);
  else if (cmd === 'all') {
    await doDiscover(db, desc);
    // enrich until drained (LIMIT 60 per pass; new DBs need >1 pass)
    let passes = 0;
    while (passes < 4) {
      const pending = db.prepare(`SELECT COUNT(*) n FROM jobs WHERE (description IS NULL OR length(description) < 100) AND url IS NOT NULL`).get().n;
      if (!pending || passes > 0 && pending >= 99999) break;
      if (!pending) break;
      const before = pending;
      await doEnrich(db);
      const after = db.prepare(`SELECT COUNT(*) n FROM jobs WHERE (description IS NULL OR length(description) < 100) AND url IS NOT NULL`).get().n;
      passes++;
      if (after === 0 || after >= before) break;
    }
    await doScore(db, desc);
    doReport(db);
  }
  else { console.log('unknown command: ' + cmd); process.exit(1); }
  if (cmd !== 'report') {
    const s = stats(db);
    progress.done({ result: s });
  }
} catch (e) {
  console.error('PIPELINE FAILED:', e);
  if (cmd !== 'report') progress.fail(e.message || String(e));
  process.exitCode = 1;
} finally {
  db.close();
}
