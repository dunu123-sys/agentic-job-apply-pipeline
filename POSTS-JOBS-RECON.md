# LINKEDIN POSTS JOB SEARCH - RECON, PROCEDURE & RESULTS (2026-10-24/25)

> NEW source built end-to-end: jobs posted as FEED POSTS (recruiter #vagas
> posts, company announcements). OPERATOR RULES honored: the existing working
> pipeline was NOT modified (all new code in NEW files); the liposts chrome
> is ISOLATED (own port/profile/PID) so it can never conflict with other
> lanes' chromes; scoring is LLM-CAPPED (no bursts).

## 0. Why posts

Brazilian recruiters constantly post openings in the feed with hashtags
(#vagas #oportunidade) or plain text ("Estamos com uma vaga de Desenvolvedor
C#..."). These posts often link DIRECTLY to the application (Greenhouse,
company site, InfoJobs, or a LinkedIn jobs URL), and are NOT in the jobs
index - the standard scraper never sees them. Goal: scrape post-search
results for job-like posts, store as source='lipost', score, surface.

## 1. Files (all NEW - nothing else touched)

| File | Role |
|---|---|
| liposts-pipeline.mjs | THE pipeline: ensure chrome -> scrape -> capped score -> report |
| scrape-liposts.mjs | Post-search scraper (16 stack keywords, 3 patient passes) |
| launch-liposts-chrome.ps1 | Isolated chrome launcher (:9225, cloned profile, --disable-gpu, PID file) |
| close-liposts-chrome.ps1 | Closes ONLY the liposts chrome (by recorded PID tree - never other lanes') |
| probe-liposts.mjs ... probe-liposts12.mjs | The 12 recon probes (kept, see sect.5) |
| POSTS-JOBS-RECON.md | This doc |

## 2. DOM contract (recon rounds 1-4)

Current LinkedIn (Renaissance UI, Oct/2026) content search:
- All CSS classes obfuscated (l4j*, unstable) - never anchor on them.
- NO data-urn, NO time[datetime], NO ld+json, no voyager state.
- Post unit = div[role="listitem"] with
  componentkey="update-card-focus<TOKEN>FeedType_FLAGSHIP_SEARCH".
  TOKEN = unique per post -> our source_id (dedupe key). (Recon first
  assumed urn:li:activity ids; the TOKEN is what actually exists.)
- Author: first a[href*="/company/" | "/in/"]; name from
  img[alt^="View company:"], div[aria-label], or first p span.
- Text: unit.innerText cut at the social-actions block ("Like" line).
- Links: all a[href] with text minus feed/company/policy noise.

## 3. Loading behavior (rounds 5-12) - every trick tested

| Attempt | Result |
|---|---|
| window.scrollBy / scrollTop | no-op (doc height == viewport; virtualized) |
| CDP wheel events (Input.dispatchMouseEvent) | WEDGES the page (evals time out; chrome eventually died). GPU-off did NOT fix -> not GPU stress; the Input wheel path is broken on this build. NEVER USE |
| &page=2 URL pagination | IGNORED (param dropped, same first posts) |
| Emulation.setDeviceMetricsOverride 1280x4200/8000 | list unchanged (3) |
| Keyboard: PageDown x8, End, Space, arrows (Input.dispatchKeyEvent) | all dispatch cleanly, no wedge - but list unchanged: there is literally nothing to scroll (operator idea, round 12) |
| Patient lazy-render (poll 3 min) | flat at 3 on a slow load; but yields vary server-side: same keyword gave 24 once, 3 other times |
| MORE KEYWORDS (the lever) | 16 stack keywords x 3-24 posts each = 78 posts, 50 new rows in one run |

Bottom line: each search page-load renders ~3 posts (occasionally a big
batch - server-side lottery). Depth is impossible; breadth works.

## 4. How to run

  cd .
  node liposts-pipeline.mjs                # full flow: chrome + scrape + score (<=5 LLM calls)
  node liposts-pipeline.mjs --limit=8      # allow up to 8 LLM calls
  node liposts-pipeline.mjs --limit=0      # scrape only, ZERO LLM calls
  node liposts-pipeline.mjs --score-only   # just drain pending rows (capped)
  node liposts-pipeline.mjs --close        # close the liposts chrome after

Chrome lifecycle handled by the pipeline (launch/close ps1, PID-tracked).
The scorer reuses verdict() from score.mjs: local hard-gates run FREE
(estagio/intern, core-stack ratio <25%, seniority) - only gate-passers
consume an LLM call. A per-call 90s timeout skips hung the router rows (they
stay pending); 2 consecutive timeouts abort the stage (router stuck - don't
hammer). This is the anti-burst design the operator required (2026-10-25).

## 5. Recon probe index

| Probe | Finding |
|---|---|
| 1 | search renders logged-in; old selectors dead |
| 2 | class obfuscation; "Feed post" label chain mapped |
| 3 | no ld+json / time[datetime] - semantic anchors dead |
| 4 | raw HTML read -> componentkey/token contract |
| 5 | thin viewport; nothing scrollable; no pagination buttons |
| 6 | ancestor walk: no overflow scroller exists |
| 7 | wheel events wedge CDP (confirmed) |
| 8 | &page=N ignored |
| 9 | isolated chrome + --disable-gpu; wheels STILL wedge; no lazy growth in 26s |
| 10 | 4200/8000px viewport override ignored |
| 11 | "Posts" filter chip absent; flat at 3 for 3+ minutes |
| 12 | keyboard clean but ineffective; confirmed nothing-to-scroll |

## 6. Results so far

- 2026-10-24 (shared :9223, pre-isolation): 18 posts -> 13 rows; 1 APPLY hit
  at 80 ("Vaga aberta em Sao Paulo - SP para Desenvolvedor .NET Pleno!").
- 2026-10-25 (isolated :9225): 16 keywords -> 78 posts, 50 new rows.
- Scoring state: 53 rows scored -> 2 APPLY, 3 REVIEW, 48 SKIP (gates
  correctly kill estagio/marketing/non-stack posts free). ~14 rows pending,
  drained a few per run by the capped pipeline.
- The operator stopped one mass-score (burst risk); the dedicated pipeline
  now enforces the LLM cap by design.

## 7. WIRED INTO THE MAIN PIPELINE (2026-10-25, operator approved)

`pipeline.mjs all --scrape=jobs|posts|both` (default both) — doDiscoverPosts
runs inside the main discover stage, auto-launching the isolated :9225
chrome. The UI RUN button takes scrape chips (JOBS/POSTS/BOTH) via
`POST {action:'run', scrape:...}` -> run-full.cmd <arg>. Production scoring
has NO LLM cap (operator rule) with a 360s per-call timeout. The standalone
`liposts-pipeline.mjs` remains as the capped/manual variant. lipost rows
never auto-queue (easy_apply=0, source<>infojobs): they surface in the SCRAP
tab for manual review, url = best link found in the post. Skill
`job-apply-pipeline` and PIPELINE-README.md reflect the wiring.

## 8. v2 ideas (parked)

- Keyword rotation list (wider coverage without re-hitting the same posts).
- Post-detail click to resolve real /posts/<slug> URLs (share-menu needed).
- Cross-source dedupe (post promotes a job already scraped from LI/IJ).
- Harvest more posts per load when the server deals a big batch (pass timing).
