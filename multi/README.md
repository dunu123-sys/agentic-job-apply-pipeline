# multi/ — multi-description pipeline (APPLIED TO PRODUCTION 2026-10-25)

Status: **APPLIED.** The production pipeline now resolves the active
description (`descriptions.mjs` at the project root) and every stage reads
from it: `pipeline.mjs --desc=NAME`, `scrape-liposts.mjs --desc=/--kws=`,
CONFIG tab selector (`set-description`), `run-full.cmd <scrape> [desc]`.
`multi/descriptions.mjs` re-exports the production loader, so this folder
remains runnable as the reference/capped implementation (`score-multi.mjs`
with `--limit=N`, `--db=` test copies) and cannot drift from production.

## What this solves

Production treats the target role as constants (`config.mjs` CANDIDATE,
`score.mjs` hardcoded core list + prompt). This module makes the target role a
**swappable unit**: one JSON in `../descriptions/` carries the profile, gates,
search keywords and thresholds for ONE role, and one description is **active
per run**.

Operator decisions baked in (2026-10-25):
1. **One description per run** — not multi-scoring in a single run.
2. **Score custom to each description** — gates, prompt and thresholds all
   come from the description.
3. **New only** — only `status='new'` rows get scored; old verdicts untouched.
4. **New files, production untouched** — nothing in `pipeline.mjs`, `score.mjs`,
   `config.mjs`, `scrape-liposts.mjs` was modified.

## Files

| File | Purpose |
|---|---|
| `descriptions.mjs` | load/validate/list descriptions; `resolveDescription` (flag → setting → default); default exclusions; compile helpers |
| `score-multi.mjs` | per-description `hardGatesDesc` (G1 core / G2 exclusions / G3 band), prompt build, SSE scoring, `verdictDesc`, `scorePendingDesc` (LLM cap, 360s timeout, 2-timeout abort) |
| `scrape-posts-multi.mjs` | posts scraper fork: keywords from `--desc` file or `--kws`; writes `found_by=['liposts:<desc>:<kw>']` |
| `pipeline-multi.mjs` | orchestrator: resolve → discover (posts/LI/IJ with description queries) → enrich → score → autoQueue80 → provenance report |
| `open.mjs` | path-parameterized DB opener (production `open()` hardcodes jobs.sqlite) |

## Usage

```bash
cd .
# real run for a description (uncapped LLM, as production)
node multi/pipeline-multi.mjs --desc=desenvolvedor
# test / capped
node multi/pipeline-multi.mjs --desc=dados --limit=3 --db=F:/.../multi-test.sqlite --score-only
# scrape only alternatives
node multi/pipeline-multi.mjs --desc=dados --scrape=posts
# single stages
node multi/score-multi.mjs --desc=dados --limit=3 --db=...
node multi/scrape-posts-multi.mjs --desc=dados --kws="vaga power bi"
```

Flags: `--db=` `--desc=` `--limit=N` (0/absent = uncapped) `--scrape=jobs|posts|both`
`--score-only` `--no-enrich` `--no-queue`.

## Test results (2026-10-25, TEST DB copy only)

Test DB: `multi-test.sqlite` = `VACUUM INTO` copy of production (302 rows).
6 rows reset to `status='new'` (3 dev-titled, 3 data/analista-titled).
LLM budget: 3 calls per description, hard gates free.

**Verdict: PASS.** LLM budget actually spent: **11 calls** in total (6 lost to
an orphaned test process that survived a tool timeout — a real finding: long
runs must be started detached and polled; the 360s guard timer also kept the
process alive after completion, fixed with `unref`+`clearTimeout`).

| Test | LLM calls | Result |
|---|---|---|
| `desenvolvedor`, cap=2 | 2 | REVIEW 64, REVIEW 72; 4 rows left pending; provenance `desenvolvedor` |
| `dados`, cap=1 | 1 | same .NET job that scored REVIEW 60 under `desenvolvedor` scored **SKIP 12** |
| `dados`, cap=0 (gates only) | 0 | **5 free gate-skips** (core ratio 13-38% < 40%), 1 row left pending |
| `desenvolvedor`, cap=0 (debug) | 0 | synthetic Portuguese text with "habilidade/mobile" → 0% (word-boundary fix works) |
| resolution | 0 | default → `desenvolvedor`; `settings.active_description=dados` honoured; flag overrides; unknown name rejected |
| posts fork `--kws="vaga power bi"` | 0 | 6 posts → 6 NEW rows in test DB, `found_by=['liposts:custom:vaga power bi']` |

Production integrity after all tests: **302 rows, 0 pending, 0 description-tagged
verdicts, settings unchanged** — production DB untouched (test used `VACUUM INTO`
copy `multi-test.sqlite`).

Bugs found and fixed during testing:
1. LLM cap blocked free gate-skips behind it → gates now always run, cap applies
   to LLM-capped rows only (they stay pending, never lost).
2. Substring gate matching: `bi` matched "hábil/mobile/responsabilidade" → short
   alphabetic terms are word-bounded now.
3. 25% core ratio passed generic .NET jobs under the `dados` description →
   per-description `minCoreRatio` knob added (dados uses 0.4).
4. 360s timeout timer kept node alive after finishing → `unref` + `clearTimeout`.
5. `db.mjs open()` hardcodes the production path → `multi/open.mjs` opens any path.

## Apply checklist (when the operator says go)

1. `pipeline.mjs`: replace `CANDIDATE`/`LI_QUERIES`/`IJ_QUERIES`/`THRESHOLDS`
   imports with `resolveDescription(db)`; pass `desc` into discover/enrich/score.
2. `score.mjs`: swap hardcoded G1 list + `CANDIDATE.profileBlock` + `THRESHOLDS`
   for `desc.*` (keep the production path working via the migrated
   `descriptions/desenvolvedor.json`, which is byte-equivalent).
3. `scrape-liposts.mjs`: accept `--kws=`/`--desc=` (then delete the fork).
4. `pipeline.mjs` auto-queue rule: unchanged — description-agnostic.
5. UI (`route.ts`/`page.tsx`): CONFIG tab gains description dropdown +
   `set-description` action; optional creator form (writes a new JSON).
6. Cron `run-full.cmd`: add `--desc=` passthrough (default = active setting).
7. Docs: mark this folder as the production implementation; update
   `PIPELINE-README.md` + `SHIPPED.md` + `job-apply-pipeline` skill.

## Known limitations

- Same posting scored under description A keeps its verdict if re-scraped under
  B (dedupe is `(source, source_id)`). No `--revisit` yet; add if needed.
- `dados.json` is a draft — profile text and keywords need operator review.
- posts discovery still first-page-only (server-side lottery 3–24/keyword);
  breadth = keyword count, which now comes from the description.
