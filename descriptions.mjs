// descriptions.mjs — target-role ("job description") loader + resolver (LIVE 2026-10-25).
// A description is a JSON file in ./descriptions/ carrying EVERYTHING the
// pipeline needs for one target role: the candidate paragraph, the gate lists,
// the search keywords and the thresholds. ONE description is active per run
// (operator decision 2026-10-25): resolution order is
//   --desc=NAME  >  settings.active_description  >  'desenvolvedor'
// Adding a role = dropping a new JSON file. No code changes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSetting } from './db.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'descriptions');

// G2 defaults, used when a description does not override `exclusions`
// (same patterns the original scorer hardcoded — behaviour preserved).
export const DEFAULT_EXCLUSIONS = [
  '\\best[áa]gio|\\bintern\\b|internship|trainee',
  '\\bvaga preenchida|position has been filled',
  '\\bmarketing digital|vendedor|telemarketing|suporte t[ée]cnico nível 1|cientista social|advogado|enfermeir',
];

export const DEFAULT_DESCRIPTION = 'desenvolvedor';

export function listDescriptions() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      return { name: j.name || f.replace(/\.json$/, ''), label: j.label || j.name || f, file: f };
    } catch {
      return { name: f.replace(/\.json$/, ''), label: f + ' (INVALID JSON)', file: f };
    }
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export function loadDescription(name) {
  const file = path.join(DIR, (name || DEFAULT_DESCRIPTION) + '.json');
  if (!fs.existsSync(file)) throw new Error('unknown description: ' + name + ' (available: ' + listDescriptions().map(d => d.name).join(', ') + ')');
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const need = ['name', 'profileBlock', 'coreStack', 'seniorityBand', 'liQueries', 'ijQueries', 'postKeywords', 'thresholds'];
  const missing = need.filter(k => !d[k]);
  if (missing.length) throw new Error(`description ${name} missing fields: ${missing.join(', ')}`);
  if (!Array.isArray(d.coreStack) || !d.coreStack.length) throw new Error(`description ${name}: coreStack must be a non-empty array`);
  return {
    ...d,
    exclusions: d.exclusions || DEFAULT_EXCLUSIONS,
    sysRole: d.sysRole || 'desenvolvedor',
    minCoreRatio: d.minCoreRatio ?? 0.25,
  };
}

// resolve: explicit flag > settings.active_description > default
export function resolveDescription(db, explicit) {
  let name = explicit;
  if (!name && db) { try { name = getSetting(db, 'active_description', DEFAULT_DESCRIPTION); } catch { name = DEFAULT_DESCRIPTION; } }
  name = name || DEFAULT_DESCRIPTION;
  return { name: loadDescription(name).name, desc: loadDescription(name) };
}

export function compileExclusions(desc) {
  return (desc.exclusions || DEFAULT_EXCLUSIONS).map(s => new RegExp(s));
}
