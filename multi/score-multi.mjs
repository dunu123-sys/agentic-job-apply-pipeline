// multi/score-multi.mjs — per-description scorer (NEW, 2026-10-25).
// Replicates the production score.mjs pattern (SSE streaming, gates first,
// JSON verdict, sanity-clamp) but every profile-dependent piece comes from
// the resolved description: G1 core list, G2 exclusions, G3 seniority band,
// the LLM prompt paragraph, the thresholds. Verdicts carry `description`
// for provenance (stored inside llm_json — no schema change).
//
//   node multi/score-multi.mjs --db=<path> --desc=desenvolvedor --limit=3 --score-only
//
// --limit caps LLM calls (testing); hard-gate skips are FREE, exactly like
// production. 360s per-call timeout (operator rule: models can be slow).
import { llmKey } from '../score.mjs';
import { LLM, PACING } from '../config.mjs';
import { getSetting } from '../db.mjs';
import { loadDescription, compileExclusions } from './descriptions.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const arg = (n, d) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=').slice(1).join('=') : d; };

// ---- gates, parameterized by description ------------------------------------
export function hardGatesDesc(job, desc) {
  const text = `${job.title || ''} ${job.description || ''} ${job.criteria || ''}`.toLowerCase();
  const fails = [];

  // G1: must-have stack coverage — the description's core list, >=25% required.
  // Short alphabetic terms are word-bounded: 'bi' must not match 'hábil'.
  const termHits = (t) => {
    const k = String(t).toLowerCase();
    if (/^[a-z]{1,4}$/.test(k)) return new RegExp('\\b' + k + '\\b').test(text);
    return text.includes(k);
  };
  const core = desc.coreStack.map(s => String(s).toLowerCase());
  const hits = core.filter(termHits);
  const coreRatio = core.length ? hits.length / core.length : 0;
  const minCoreRatio = desc.minCoreRatio ?? 0.25; // per-description tuning knob
  if (coreRatio < minCoreRatio) fails.push(`core-stack ratio ${Math.round(coreRatio * 100)}% < ${Math.round(minCoreRatio * 100)}% [${desc.name}]`);

  // G2: exclusions — description override or the shared defaults
  for (const rx of compileExclusions(desc)) if (rx.test(text)) { fails.push(`exclusion: ${rx.source.slice(0, 30)}`); break; }

  // G3: seniority band — reject senior/director-only titles outside the band
  const t = (job.title || '').toLowerCase();
  const bandRx = new RegExp(desc.seniorityBand.map(s => '\\b' + s.toLowerCase() + '\\b').join('|'));
  if (/\bsenior\b|\bs[êe]nior\b|\bhead of\b|\bgerente de tecnologia\b|\btech lead\b|\bdiretor\b/.test(t)
      && !bandRx.test(t)) {
    const crit = String(job.criteria || '').toLowerCase();
    if (!/j[úu]nior|pleno|assistente|não aplicável/.test(crit)) fails.push(`seniority: outside band [${desc.name}]`);
  }

  return { fails, coreRatio };
}

// ---- prompt, parameterized by description -----------------------------------
const sysFor = (desc) =>
  `Você avalia se um post é uma vaga de emprego real para ${desc.sysRole}. ` +
  'Responda SOMENTE JSON válido, sem markdown: ' +
  '{"hiring":bool,"jobTitle":"...","seniority":"junior|pleno|senior|na","remote":bool,' +
  '"stackMatch":0-100,"score":0-100,"recommendation":"APPLY|REVIEW|SKIP","confidence":0-1}';

function buildPromptDesc(job, desc) {
  const crit = Array.isArray(job.criteria) ? job.criteria.join(' | ') : String(job.criteria || '');
  const post = [job.title, job.company, job.location, crit, job.description]
    .filter(Boolean).join('\n').slice(0, 3000);
  return 'Post (PT):\n' + post +
    '\n\nPerfil do candidato:\n' + desc.profileBlock +
    '\n\nscore = quão boa a vaga é para este candidato (0=ruim,100=ótima). ' +
    `recommendation = APPLY se score>=${desc.thresholds.apply}, REVIEW se ${desc.thresholds.review}-${desc.thresholds.apply - 1}, SKIP se <${desc.thresholds.review}.`;
}

// ---- one LLM call (SSE assembly — mirrors production scoreOne) ---------------
export async function scoreOneDesc(job, key, model, desc) {
  const res = await fetch(LLM.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: sysFor(desc) }, { role: 'user', content: buildPromptDesc(job, desc) }],
      max_tokens: LLM.maxTokens, temperature: 0,
      stream: true, // combos return SSE even with stream:false — always stream
    }),
  });
  let content = '', resolved = null;
  const rd = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await rd.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const ln of lines) {
      const s = ln.trim();
      if (!s.startsWith('data:')) continue;
      const p = s.slice(5).trim();
      if (!p || p === '[DONE]') continue;
      try {
        const j = JSON.parse(p);
        if (j.model) resolved = j.model;
        const d = j.choices?.[0]?.delta;
        if (d?.content) content += d.content;
      } catch { /* skip malformed chunk */ }
    }
  }
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) return { parse_ok: false, error: 'no-json', raw: content.slice(0, 120), resolved };
  try {
    const parsed = JSON.parse(m[0]);
    return { parse_ok: true, ...parsed, hiring: !!parsed.hiring, score: Number(parsed.score) || 0, model: resolved || model };
  } catch {
    return { parse_ok: false, error: 'bad-json', raw: content.slice(0, 120), resolved };
  }
}

// ---- one LLM verdict for a gate-passing job (models fallback chain) -----------
export async function scoreOneDescOnce(job, key, models, desc) {
  let last;
  for (const model of models) {
    last = await scoreOneDesc(job, key, model, desc);
    if (last.parse_ok) { last.model = model; break; }
  }
  if (!last.parse_ok) return { ...last, recommendation: 'SKIP', score: 0, gate_fail: 'llm-parse-fail', description: desc.name };
  if (last.score >= desc.thresholds.apply) last.recommendation = 'APPLY';
  else if (last.score >= desc.thresholds.review) last.recommendation = 'REVIEW';
  else last.recommendation = 'SKIP';
  last.gate_fail = null;
  last.description = desc.name;
  return last;
}

// ---- full verdict for one job: gates (free) -> LLM (capped by caller) ---------
export async function verdictDesc(job, key, models, desc) {
  const gates = hardGatesDesc(job, desc);
  if (gates.fails.length) {
    return {
      hiring: false, score: Math.min(35, Math.round(gates.coreRatio * 40)),
      recommendation: 'SKIP', confidence: 1, gate_fail: gates.fails.join('; '),
      gate_only: true, stackMatch: Math.round(gates.coreRatio * 100),
      description: desc.name,
    };
  }
  let last;
  for (const model of models) {
    last = await scoreOneDesc(job, key, model, desc);
    if (last.parse_ok) { last.model = model; break; }
  }
  if (!last.parse_ok) return { ...last, recommendation: 'SKIP', score: 0, gate_fail: 'llm-parse-fail', description: desc.name };
  if (last.score >= desc.thresholds.apply) last.recommendation = 'APPLY';
  else if (last.score >= desc.thresholds.review) last.recommendation = 'REVIEW';
  else last.recommendation = 'SKIP';
  last.gate_fail = null;
  last.description = desc.name;
  return last;
}

// ---- CLI: score pending rows for one description, capped --------------------
export async function scorePendingDesc(db, descName, limit = 5) {
  const desc = loadDescription(descName);
  const combo = getSetting(db, 'score_combo', 'default');
  const models = [combo, combo, LLM.models[LLM.models.length - 1]];
  const key = llmKey();
  if (!key) throw new Error('no the router key');

  const jobs = db.prepare(
    `SELECT source, source_id, title, company, location, description, criteria, easy_apply
     FROM jobs WHERE status='new' AND description IS NOT NULL AND length(description) > 200
     ORDER BY first_seen ASC LIMIT 200`
  ).all();
  console.log(`[score-multi] description=${desc.name} pending=${jobs.length} LLM cap=${limit} combo=${combo}`);

  let llmUsed = 0, timeouts = 0, freeSkips = 0, leftPending = 0;
  const counts = { APPLY: 0, REVIEW: 0, SKIP: 0 };
  const save = (job, v) => {
    db.prepare(`UPDATE jobs SET score=?, recommendation=?, llm_json=?, gate_fail=?, scored_at=?, status='scored'
                WHERE source=? AND source_id=?`)
      .run(v.score, v.recommendation, JSON.stringify(v), v.gate_fail || null,
           new Date().toISOString(), job.source, job.source_id);
    if (counts[v.recommendation] !== undefined) counts[v.recommendation]++;
    console.log(`  ${v.recommendation} ${v.score} | ${(job.title || '').slice(0, 45)}${v.gate_only ? ' (free gate-skip)' : ` (LLM ${llmUsed}/${limit})`}`);
  };
  for (const job of jobs) {
    // 1) FREE gates always run — the LLM cap must never block them
    const gates = hardGatesDesc(job, desc);
    if (gates.fails.length) {
      freeSkips++;
      save(job, {
        hiring: false, score: Math.min(35, Math.round(gates.coreRatio * 40)),
        recommendation: 'SKIP', confidence: 1, gate_fail: gates.fails.join('; '),
        gate_only: true, stackMatch: Math.round(gates.coreRatio * 100),
        description: desc.name,
      });
      continue;
    }
    // 2) only gate-PASSING rows cost an LLM call, and only up to the cap
    if (llmUsed >= limit) { leftPending++; continue; }
    if (timeouts >= 2) { console.log('  2 timeouts — the router stuck, aborting'); break; }
    let v;
    try {
      v = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('llm-timeout-360s')), 360_000);
        t.unref?.(); // never hold the event loop open after the run finishes
        scoreOneDescOnce(job, key, models, desc).then(resolve, reject).finally(() => clearTimeout(t));
      });
    } catch (e) {
      timeouts++;
      leftPending++;
      console.log(`  TIMEOUT ${e.message} | ${(job.title || '').slice(0, 45)} — stays pending`);
      continue;
    }
    llmUsed++;
    save(job, v);
    await sleep(PACING.score);
  }
  if (leftPending) console.log(`  LLM cap reached — ${leftPending} gate-passing rows left pending (free gate-skips: ${freeSkips})`);
  console.log(`  done [${desc.name}]: ${JSON.stringify(counts)} (LLM ${llmUsed}/${limit}, free-gate ${freeSkips}, pending ${leftPending}, timeouts ${timeouts})`);
  return counts;
}

// standalone test entry
if (process.argv[1].includes('score-multi')) {
  const { openDb } = await import('./open.mjs');
  const db = openDb(arg('db', './jobs.sqlite'));
  await scorePendingDesc(db, arg('desc', 'desenvolvedor'), Number(arg('limit', 5)));
  db.close();
}
