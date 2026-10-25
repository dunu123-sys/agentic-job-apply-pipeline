// liposts-pipeline.mjs — DEDICATED pipeline for the LinkedIn-posts source
// (NEW file 2026-10-25; the main pipeline.mjs is NOT modified).
//
// Operator rule 2026-10-25: never burst LLM calls by mass-scoring posts.
// This pipeline:
//   1. ensures the ISOLATED chrome (:9225, cloned profile, --disable-gpu,
//      PID-tracked - other lanes' chromes are never touched)
//   2. scrapes post search keywords (scrape-liposts.mjs, child process)
//   3. scores with a HARD LLM-CALL CAP: verdict() runs FREE local gates
//      first (estagio/intern, core-stack ratio, seniority) - only rows that
//      pass the gates consume an LLM call, and at most --limit calls per run.
//
//   node liposts-pipeline.mjs                  # scrape + score (<=5 LLM calls)
//   node liposts-pipeline.mjs --limit=8        # allow up to 8 LLM calls
//   node liposts-pipeline.mjs --limit=0         # scrape only, zero LLM
//   node liposts-pipeline.mjs --kw="vaga azure" # single custom keyword
//   node liposts-pipeline.mjs --score-only      # skip scraping
//   node liposts-pipeline.mjs --close           # close the liposts chrome after

import { spawn } from 'node:child_process';
import { open, saveScore } from './db.mjs';
import { llmKey, verdict } from './score.mjs';
import { PACING } from './config.mjs';

const DIR = '.';
const DB = DIR + '/jobs.sqlite';
const PORT = process.env.CDP_PORT || '9225';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);

const arg = (n, d) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=').slice(1).join('=') : d; };
const LIMIT = Number(arg('limit', 5));        // max LLM calls per run
const KW = arg('kw', '');
const SCORE_ONLY = process.argv.includes('--score-only');
const CLOSE = process.argv.includes('--close');

async function cdpAlive() {
  try { await (await fetch('http://127.0.0.1:' + PORT + '/json/version', { signal: AbortSignal.timeout(3000) })).json(); return true; } catch { return false; }
}

async function ensureChrome() {
  if (await cdpAlive()) { console.log(`[${ts()}] liposts chrome already up (:${PORT})`); return; }
  console.log(`[${ts()}] launching isolated liposts chrome...`);
  spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DIR + '/launch-liposts-chrome.ps1'], { stdio: 'inherit' });
  for (let i = 0; i < 15; i++) { await sleep(2000); if (await cdpAlive()) { console.log(`[${ts()}] chrome up (pid file recorded)`); return; } }
  throw new Error('liposts chrome did not come up on :' + PORT);
}

async function scrape() {
  console.log(`[${ts()}] STAGE: scrape posts${KW ? ' (kw=' + KW + ')' : ' (default keywords)'}`);
  const args = ['scrape-liposts.mjs'];
  if (KW) args.push('--kw=' + KW);
  await new Promise((res, rej) => {
    const p = spawn('node', args, { cwd: DIR, stdio: 'inherit' });
    p.on('exit', c => c === 0 ? res() : rej(new Error('scrape exit ' + c)));
  });
}

async function scoreCapped(db) {
  const pend = db.prepare(
    `SELECT source, source_id, title, company, location, description, criteria, easy_apply
     FROM jobs WHERE source='lipost' AND status='new' AND description IS NOT NULL
       AND length(description) > 200 ORDER BY first_seen ASC`
  ).all();
  console.log(`[${ts()}] STAGE: score (pending=${pend.length}, LLM cap=${LIMIT})`);
  if (!pend.length) return;

  const key = llmKey();
  const { LLM } = await import('./config.mjs');
  let llmUsed = 0, timeouts = 0, counts = { APPLY: 0, REVIEW: 0, SKIP: 0 };
  const CALL_TIMEOUT = 360_000;                    // operator rule 2026-10-25: models can be slow
  for (const job of pend) {                        // never block the whole run
    if (llmUsed >= LIMIT) { console.log(`  LLM cap reached (${LIMIT}) - rest stays pending for next run`); break; }
    if (timeouts >= 2) { console.log('  the router looks stuck (2 timeouts) - aborting stage, rest stays pending'); break; }

    let v;
    try {
      v = await Promise.race([
        verdict(job, key, LLM.models),
        new Promise((_, rej) => setTimeout(() => rej(new Error('llm-timeout')), CALL_TIMEOUT)),
      ]);
    } catch (e) {
      timeouts++;
      console.log(`  TIMEOUT ${e.message} | ${(job.title || '').slice(0, 50)} - row stays pending`);
      continue;                                    // skip; do NOT consume cap
    }
    if (!v.gate_only) llmUsed++;                    // only gate-passers cost a call
    saveScore(db, 'lipost', job.source_id, v);
    if (counts[v.recommendation] !== undefined) counts[v.recommendation]++;
    const tag = v.gate_only ? ' (free gate-skip)' : ` (LLM ${llmUsed}/${LIMIT})`;
    console.log(`  ${v.recommendation} ${v.score} | ${(job.title || '').slice(0, 50)}${tag}`);
    if (!v.gate_only) await sleep(PACING.score);
  }
  console.log(`  done: ${JSON.stringify(counts)} (LLM calls used: ${llmUsed}/${LIMIT}, timeouts: ${timeouts})`);
  if (timeouts) process.exitCode = 0;              // a hung promise may linger;
  if (timeouts) { db.close(); process.exit(0); }    // exit hard so it can't block
}

async function report(db) {
  const rows = db.prepare(
    `SELECT score, recommendation, company, title, url FROM jobs
     WHERE source='lipost' AND status='scored' AND recommendation <> 'SKIP'
     ORDER BY score DESC LIMIT 10`
  ).all();
  console.log(`[${ts()}] top lipost leads:`);
  rows.forEach(r => console.log(`  ${r.score} ${r.recommendation} | ${(r.company || '?').slice(0, 20)} | ${(r.title || '').slice(0, 55)}`));
  const pend = db.prepare(`SELECT COUNT(*) n FROM jobs WHERE source='lipost' AND status='new'`).get();
  console.log(`  (lipost rows still pending: ${pend.n})`);
}

const db = open(DB);
try {
  if (!SCORE_ONLY) { await ensureChrome(); await scrape(); }
  await scoreCapped(db);
  await report(db);
  if (CLOSE) {
    console.log(`[${ts()}] closing liposts chrome (pid file)`);
    spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DIR + '/close-liposts-chrome.ps1'], { stdio: 'inherit' });
  }
} catch (e) { console.error('liposts-pipeline FAILED:', e.message); process.exitCode = 1; }
db.close();
