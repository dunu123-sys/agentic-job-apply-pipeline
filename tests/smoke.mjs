import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('fixtures load into a fresh ledger and the report query sees them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobapply-'));
  process.env.JOBAPPLY_DATA_DIR = dir;

  execFileSync(process.execPath, [path.join(repo, 'fixtures', 'load.mjs')], {
    cwd: repo,
    env: process.env,
    stdio: 'pipe',
  });

  const { open, stats } = await import('../db.mjs');
  const db = open();
  const s = stats(db);
  db.close();

  assert.equal(s.total, 6, 'six fixture rows');
  assert.equal(s.byRec.find(r => r.recommendation === 'APPLY').n, 3);
  assert.equal(s.byRec.find(r => r.recommendation === 'SKIP').n, 1);
});

test('description profiles load and expose the scoring contract', async () => {
  const { loadDescription } = await import('../descriptions.mjs');
  const d = loadDescription('desenvolvedor');
  for (const key of ['profileBlock', 'coreStack', 'seniorityBand', 'thresholds', 'liQueries']) {
    assert.ok(d[key] !== undefined, `missing ${key}`);
  }
  assert.ok(Array.isArray(d.coreStack) && d.coreStack.length > 0);
});

test('db module exposes the ledger API used by the stages', async () => {
  const mod = await import('../db.mjs');
  for (const fn of ['open', 'upsertJob', 'pendingScore', 'saveScore', 'autoQueue80', 'stats',
                    'getSetting', 'setSetting']) {
    assert.equal(typeof mod[fn], 'function', `missing ${fn}`);
  }
});
