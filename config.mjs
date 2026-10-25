// Central config for the job-apply extraction pipeline.
// MULTI-DESCRIPTION (2026-10-25): the candidate profile, search keywords and
// thresholds are NOT constants here anymore — they live in descriptions/<name>.json
// and the ACTIVE description (--desc > settings.active_description) is resolved
// per run by descriptions.mjs. The exports below are the DEFAULT description
// (desenvolvedor) for backward compatibility with older scripts. Never hand-edit
// a profile per posting; edit/create a description file instead.
import { loadDescription } from './descriptions.mjs';

const DEFAULT_DESC = loadDescription('desenvolvedor');

export const CANDIDATE = {
  name: 'Example Candidate',
  role: DEFAULT_DESC.sysRole,
  stack: DEFAULT_DESC.coreStack,
  seniorityTarget: DEFAULT_DESC.seniorityBand,
  location: 'São Paulo SP',
  remoteOk: true,
  english: 'fluente',
  profileBlock: DEFAULT_DESC.profileBlock,
};

// LinkedIn: (keywords, location) combos. Kept PT-BR — the postings are Portuguese.
export const LI_QUERIES = DEFAULT_DESC.liQueries;
// extra search filters (freshness = past week; workplace 2=remote 3=hybrid)
export const LI_FILTERS = DEFAULT_DESC.liFilters || { f_TPR: 'r604800' };

// InfoJobs: palabra (+poblacion for São Paulo city). Pagination is JS-driven, so
// we fan out across keyword combos instead of page-walking.
export const IJ_QUERIES = DEFAULT_DESC.ijQueries;

// scoring thresholds (rubric: >=75 APPLY, 55-74 REVIEW, else SKIP)
export const THRESHOLDS = DEFAULT_DESC.thresholds;

// pacing (ms) — keep LinkedIn polite: 2-5s between hits, per research.
export const PACING = { search: 2500, detail: 1800, score: 300 };

export const LLM = {
  // Any OpenAI-compatible endpoint (llama.cpp server, vLLM, LiteLLM, a hosted
  // gateway). The pipeline only needs /chat/completions.
  url: process.env.LLM_URL || 'http://127.0.0.1:20128/v1/chat/completions',
  // Two attempts on the primary model because a flaky router leg can return
  // HTTP 200 with an EMPTY body; the last entry is an independent fallback so a
  // dead primary never silently marks jobs SKIP. Override with LLM_MODELS=a,b,c
  models: (process.env.LLM_MODELS || 'gpt-oss-120b,gpt-oss-120b,gpt-oss-120b')
    .split(',').map(s => s.trim()).filter(Boolean),
  maxTokens: 2500,
  // Optional file holding `api_key: 'sk-...'` (never committed), or LLM_API_KEY.
  keyFile: process.env.LLM_KEY_FILE || './secrets.yaml',
};
