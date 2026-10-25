// Run-state writer: the pipeline reports stage progress here, and the Gosplan
// /api/jobapply route reads the same file. One source of truth for UI state.

import fs from 'node:fs';

export const STATE_FILE = './run-state.json';
export const LOG_FILE = './run-log.txt';

export function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

export function report(patch) {
  const prev = readState() || {};
  const next = { ...prev, ...patch, updatedAt: new Date().toISOString() };
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 1)); } catch { /* non-fatal */ }
  return next;
}

export function stage(name, detail, extra = {}) {
  const order = ['discover', 'enrich', 'score', 'done'];
  return report({ stage: name, stageIndex: order.indexOf(name), detail, ...extra });
}

export function start() {
  return report({
    runId: 'run-' + Date.now(),
    pid: process.pid,
    stage: 'discover', stageIndex: 0, detail: 'starting',
    startedAt: new Date().toISOString(), endedAt: null, error: null,
    counts: { discovered: 0, inserted: 0, known: 0, enriched: 0, scored: 0, apply: 0, review: 0, skip: 0 },
  });
}

export function counts(patch) {
  const prev = readState() || {};
  const c = { ...(prev.counts || {}), ...patch };
  return report({ counts: c });
}

export function done(extra = {}) {
  return report({ stage: 'done', stageIndex: 3, detail: 'finished', endedAt: new Date().toISOString(), ...extra });
}

export function fail(err) {
  return report({ stage: 'error', detail: String(err).slice(0, 300), endedAt: new Date().toISOString(), error: String(err).slice(0, 500) });
}
