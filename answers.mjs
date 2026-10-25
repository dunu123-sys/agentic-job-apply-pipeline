// answers.mjs — the two question pipelines:
//   1) RESOLVE: identify a screening question, answer from the resume; if the
//      resume has no answer, generate a moderate, professional one ("good but
//      not too good"); sensitive topics default safe.
//   2) BANK: every resolved answer is stored in answer-bank.json (fuzzy key)
//      and reused automatically on any later application.
import fs from 'node:fs';

const BANK = './answer-bank.json';
const RESUME_FILE = './resume.md';

// ---- normalize -----------------------------------------------------------
export function norm(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // strip accents
    .replace(/[^a-z0-9\s|]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// ---- bank ------------------------------------------------------------------
export function loadBank() {
  try { return JSON.parse(fs.readFileSync(BANK, 'utf8')); }
  catch { return { entries: [] }; }
}
export function saveBank(bank) {
  fs.writeFileSync(BANK, JSON.stringify(bank, null, 2));
}

// fuzzy hit: every '|' -separated token of the entry's key appears in the question
export function bankLookup(question) {
  const qn = norm(question);
  const bank = loadBank();
  for (const e of bank.entries) {
    const patterns = norm(e.q).split('|').map(p => p.trim()).filter(Boolean);
    const hit = patterns.some(p => qn.includes(p));
    if (hit) return { answer: e.a, source: e.source, pattern: e.q, matched: true };
  }
  return { matched: false };
}

export function bankStore(question, answer, source = 'auto') {
  const bank = loadBank();
  // dedupe: if an existing pattern already matches this question, update the answer
  const qn = norm(question);
  for (const e of bank.entries) {
    if (norm(e.q).split('|').some(p => qn.includes(p.trim()))) {
      e.used_on = [...new Set([...(e.used_on || []), qn.slice(0, 80)])];
      return false; // already covered
    }
  }
  bank.entries.push({ q: qn.slice(0, 120), a: String(answer).slice(0, 120), source, created_at: new Date().toISOString() });
  saveBank(bank);
  return true;
}

export function recordUse(question) {
  const bank = loadBank();
  const qn = norm(question);
  for (const e of bank.entries) {
    if (norm(e.q).split('|').some(p => qn.includes(p.trim()))) {
      e.uses = (e.uses || 0) + 1; e.last_used = new Date().toISOString();
      saveBank(bank); return;
    }
  }
}

// ---- resume ----------------------------------------------------------------
export function resumeText() {
  try { return fs.readFileSync(RESUME_FILE, 'utf8'); } catch { return ''; }
}

// ---- LLM resolve (OpenAI-compatible router, streaming SSE) ---------------------
const KEY = process.env.LLM_API_KEY || '';
const LLM_URL = process.env.LLM_URL || 'http://127.0.0.1:20128/v1/chat/completions';

export async function llmResolve(question, jobTitle) {
  const sys =
    'Você responde perguntas de formulários de candidatura de emprego (LinkedIn Easy Apply) ' +
    'para o candidato descrito. Responda SOMENTE JSON: {"answer":"..."}\n' +
    'REGRAS:\n' +
    '- Responda em português, MUITO curto (um número, "Sim"/"Não", ou uma frase de até 15 palavras).\n' +
    '- Baseie a resposta APENAS no currículo quando possível.\n' +
    '- Se o currículo não tiver a resposta, dê uma resposta PROFISSIONAL E MODERADA — nunca ' +
    'exagerada, nunca invente empresas, habilidades ou conquistas. Melhor subestimar que inflar.\n' +
    '- Salário/pretensão salarial → "A combinar" sempre (a menos que o banco diga outro valor).\n' +
    '- Perguntas de disponibilidade (híbrido/presencial/remoto) → o candidato é de São Paulo e ' +
    'aceita remoto ou híbrido → responda de acordo. Presencial fora de São Paulo → "Não".\n' +
    '- Anos de experiência: conte a partir das datas do currículo, arredonde para BAIXO.\n' +
    '- Sobre vivências específicas que o currículo não mostra (ex.: uma tecnologia, um setor), ' +
    'responda com honestidade moderada: experiência básica/intermediária se for plausível pela ' +
    'stack geral; nunca afirme domínio de algo fora do currículo.';
  const user = 'VAGA: ' + (jobTitle || 'desenvolvedor') +
    '\n\nCURRÍCULO DO CANDIDATO:\n' + resumeText().slice(0, 2500) +
    '\n\nPERGUNTA DO FORMULÁRIO:\n' + String(question).slice(0, 400) +
    '\n\nResponda {"answer":"..."}';

  for (const model of (process.env.LLM_MODELS || 'gpt-oss-120b').split(',').map(s => s.trim()).filter(Boolean)) {
    try {
      const res = await fetch(LLM_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
                                max_tokens: 1200, temperature: 0, stream: true }),
      });
      let content = '';
      const rd = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      while (true) { const { done, value } = await rd.read(); if (done) break;
        buf += dec.decode(value, { stream: true }); const lines = buf.split('\n'); buf = lines.pop();
        for (const ln of lines) { const s = ln.trim(); if (!s.startsWith('data:')) continue;
          const p = s.slice(5).trim(); if (!p || p === '[DONE]') continue;
          try { const d = JSON.parse(p).choices?.[0]?.delta?.content; if (d) content += d; } catch {} } }
      const m = content.match(/\{[\s\S]*\}/);
      if (m) { const j = JSON.parse(m[0]); if (j.answer) return { answer: String(j.answer).slice(0, 120), source: 'llm', model }; }
    } catch { /* try next model */ }
  }
  return { answer: null, source: 'none' };
}

// ---- the full resolve pipeline ----------------------------------------------
export async function resolveAnswer(question, jobTitle) {
  const q = String(question || '').trim();
  if (!q) return { answer: null, source: 'empty' };
  // 1) bank first (operator-edited > resume > auto)
  const hit = bankLookup(q);
  if (hit.matched) { recordUse(q); return { answer: hit.answer, source: 'bank:' + hit.source }; }
  // 2) LLM from resume with moderate fallback
  const ll = await llmResolve(q, jobTitle);
  if (ll.answer) {
    // 3) store for later reuse (auto entries can be operator-edited in the file)
    bankStore(q, ll.answer, 'auto');
    return { answer: ll.answer, source: ll.source };
  }
  return { answer: null, source: 'unresolved' };
}
