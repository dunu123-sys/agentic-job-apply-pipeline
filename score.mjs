// ATS scorer — 3-stage rubric (gates -> weighted -> deductions) with LLM adjudication.
// Read ats-scoring-rubric.md in the job-apply-pipeline skill for the spec.
// Key fix vs the legacy n8n node: the HARD GATES are enforced in code, not left to the model.

import fs from 'node:fs';
import { LLM, PACING } from './config.mjs';
import { loadDescription, compileExclusions } from './descriptions.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// MULTI-DESCRIPTION (2026-10-25): every profile-dependent piece now comes from
// the ACTIVE description (descriptions/<name>.json). Callers that pass no
// `desc` get `desenvolvedor.json` — the previous hardcoded profile verbatim.
const DEFAULT_DESC = loadDescription('desenvolvedor');

export function llmKey() {
  const cfg = fs.readFileSync(LLM.keyFile, 'utf8');
  return (cfg.match(/api_key:\s*'(sk-[A-Za-z0-9_-]+)'/) || [])[1];
}

// Stage 1 — hard gates, deterministic. Fail any -> SKIP, cap 0-40.
export function hardGates(job, desc = DEFAULT_DESC) {
  const text = `${job.title || ''} ${job.description || ''} ${job.criteria || ''}`.toLowerCase();
  const fails = [];

  // G1: must-have stack coverage — the description's core list.
  // Short alphabetic terms are word-bounded ('bi' must not match 'hábil',
  // 'sql' must not match 'mysql'); longer terms / symbols stay substring.
  const termHits = (t) => {
    const k = String(t).toLowerCase();
    if (/^[a-z]{1,4}$/.test(k)) return new RegExp('\\b' + k + '\\b').test(text);
    return text.includes(k);
  };
  const core = desc.coreStack.map(s => String(s).toLowerCase());
  const hits = core.filter(termHits);
  const coreRatio = core.length ? hits.length / core.length : 0;
  const minCoreRatio = desc.minCoreRatio ?? 0.25;
  if (coreRatio < minCoreRatio) fails.push(`core-stack ratio ${Math.round(coreRatio * 100)}% < ${Math.round(minCoreRatio * 100)}%`);

  // G2: exclusions — description override or the shared defaults.
  for (const rx of compileExclusions(desc)) if (rx.test(text)) { fails.push(`exclusion: ${rx.source.slice(0, 30)}`); break; }

  // G3: seniority band — reject postings that are explicitly senior-only or director+.
  const t = (job.title || '').toLowerCase();
  const bandRx = new RegExp(desc.seniorityBand.map(s => '\\b' + String(s).toLowerCase() + '\\b').join('|'));
  if (/\bsenior\b|\bs[êe]nior\b|\bhead of\b|\bgerente de tecnologia\b|\btech lead\b|\bdiretor\b/.test(t)
      && !bandRx.test(t)) {
    // seniority criteria can soften it
    const crit = String(job.criteria || '').toLowerCase();
    if (!/j[úu]nior|pleno|assistente|não aplicável/.test(crit)) fails.push('seniority: explicit senior/director title');
  }

  return { fails, coreRatio };
}

const sysFor = (desc) =>
  `Você avalia se um post é uma vaga de emprego real para ${desc.sysRole}. ` +
  'Responda SOMENTE JSON válido, sem markdown: ' +
  '{"hiring":bool,"jobTitle":"...","seniority":"junior|pleno|senior|na","remote":bool,' +
  '"stackMatch":0-100,"score":0-100,"recommendation":"APPLY|REVIEW|SKIP","confidence":0-1}';

function buildPrompt(job, desc) {
  const crit = Array.isArray(job.criteria) ? job.criteria.join(' | ') : String(job.criteria || '');
  const post = [job.title, job.company, job.location, crit, job.description]
    .filter(Boolean).join('\n').slice(0, 3000);
  const th = desc.thresholds;
  return 'Post (PT):\n' + post +
    '\n\nPerfil do candidato:\n' + desc.profileBlock +
    '\n\nscore = quão boa a vaga é para este candidato (0=ruim,100=ótima). ' +
    `recommendation = APPLY se score>=${th.apply}, REVIEW se ${th.review}-${th.apply - 1}, SKIP se <${th.review}.`;
}

export async function scoreOne(job, key, model, desc = DEFAULT_DESC) {
  const res = await fetch(LLM.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: sysFor(desc) }, { role: 'user', content: buildPrompt(job, desc) }],
      max_tokens: LLM.maxTokens, temperature: 0,
      stream: true, // combos return SSE even with stream:false (empty content) — always stream
    }),
  });
  // assemble SSE chunks into plain content
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
        if (j.model) resolved = j.model; // actual model behind the combo leg
        const d = j.choices?.[0]?.delta;
        if (d?.content) content += d.content;
      } catch { /* skip malformed chunk */ }
    }
  }
  const m = content.match(/\{[\s\S]*\}/); // strip fences, first {...}
  if (!m) return { parse_ok: false, error: 'no-json', raw: content.slice(0, 120), resolved };
  try {
    const parsed = JSON.parse(m[0]);
    return { parse_ok: true, ...parsed, hiring: !!parsed.hiring, score: Number(parsed.score) || 0, model: resolved || model };
  } catch {
    return { parse_ok: false, error: 'bad-json', raw: content.slice(0, 120), resolved };
  }
}

// Full verdict for one job: gates first, then LLM.
export async function verdict(job, key, models, desc = DEFAULT_DESC) {
  const gates = hardGates(job, desc);
  if (gates.fails.length) {
    return {
      hiring: false, score: Math.min(35, Math.round(gates.coreRatio * 40)),
      recommendation: 'SKIP', confidence: 1, gate_fail: gates.fails.join('; '),
      gate_only: true, stackMatch: Math.round(gates.coreRatio * 100),
      description: desc.name, // provenance (stored inside llm_json)
    };
  }
  let last;
  for (const model of models) {
    last = await scoreOne(job, key, model, desc);
    if (last.parse_ok) { last.model = model; break; }
  }
  if (!last.parse_ok) return { ...last, recommendation: 'SKIP', score: 0, gate_fail: 'llm-parse-fail', description: desc.name };
  // sanity-clamp against the description's thresholds
  const th = desc.thresholds;
  if (last.score >= th.apply) last.recommendation = 'APPLY';
  else if (last.score >= th.review) last.recommendation = 'REVIEW';
  else last.recommendation = 'SKIP';
  last.gate_fail = null;
  last.description = desc.name;
  return last;
}

export async function scoreAll(jobs, key, desc = DEFAULT_DESC) {
  const out = [];
  for (const job of jobs) {
    const v = await verdict(job, key, LLM.models, desc);
    out.push({ job, verdict: v });
    await sleep(PACING.score);
  }
  return out;
}
