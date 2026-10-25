# agentic-job-apply-pipeline

An agent-operated job-search pipeline: discover postings from several sources, score them against a candidate profile with an LLM rubric, and apply through platform-native flows — with consent gates, caps and an audit trail at every step.

Built to run unattended on a single Windows machine (Node 24, SQLite, local or hosted OpenAI-compatible models), then supervised through a small control panel.

> **Responsible use.** Automating actions on job platforms can conflict with their terms of service, and accounts can be restricted. This repository is published for research and education: it documents the architecture, the scoring methodology and the consent/verification patterns. You are responsible for what you run against a real account. The shipped code defaults to safe behaviour: previews, dry runs, explicit consent files and hard caps.

## What it does

```
                 ┌─────────────┐   ┌─────────────┐   ┌──────────────────┐
  sources   ───▶ │  discovery  │──▶│    enrich   │──▶│  LLM scoring     │
  LinkedIn jobs  │  dedupe on  │   │  full JD,   │   │  gates + rubric  │
  InfoJobs       │  platform   │   │  contacts,  │   │  0-100, verdict  │
  LinkedIn posts │  posting id │   │  apply mode │   │  APPLY/REVIEW/   │
                 └─────────────┘   └─────────────┘   │  SKIP            │
                                                     └────────┬─────────┘
                                                              │
                        ┌─────────────────────────────────────┴───────────┐
                        ▼                                                 ▼
              ┌───────────────────┐                            ┌──────────────────┐
              │ consent-gated     │                            │ human queue      │
              │ apply runners     │                            │ (links, email,   │
              │ Easy Apply /      │                            │  WhatsApp digest)│
              │ InfoJobs native   │                            │                  │
              └─────────┬─────────┘                            └──────────────────┘
                        ▼
              ┌───────────────────┐
              │ verification      │  page state + confirmation email,
              │ SQLite ledger     │  every action logged, one outreach
              │ + audit log       │  per posting, idempotent re-runs
              └───────────────────┘
```

**Verified operator run:** 162 postings collected (91 LinkedIn + 71 InfoJobs), 28 APPLY / 61 REVIEW / 73 SKIP, zero parse failures; 5 of 5 approved applications confirmed twice (page state + confirmation email). Numbers come from the author's runs on this codebase; the fixtures in `fixtures/` let you reproduce the data flow offline.

## Design principles

- **Idempotent stages.** `discover → enrich → score → report`; each stage can be killed and re-run. Only `status='new'` rows are scored, so a crash never re-scores or double-applies.
- **Dedupe on the platform id**, never on text — the same posting is reposted verbatim across groups and metro areas.
- **Hard gates before the model.** Missing must-have skills, seniority band, location or explicit exclusions fail before any LLM call; no score overrides a failed gate.
- **Structured output or nothing.** Every scoring call must return parseable JSON; a timeout leaves the row pending instead of guessing.
- **Human gates on anything outward.** Applications are capped, consent is recorded per site, and email/WhatsApp sends preview before firing.
- **Verify, don't assume.** A submission counts only when the page state or the confirmation email agrees.

## Scoring rubric

| Stage | What happens |
|---|---|
| 1. Hard gates | must-have coverage, seniority band, location, exclusions → SKIP on failure |
| 2. Weighted score | title 20 / must-have 30 / nice-to-have 10 / seniority 20 / location 10 / recency 10 |
| 3. Red flags | missing must-have −15, job-hopping −8, onsite-vs-remote −10 |
| Verdict | ≥75 APPLY · 55–74 REVIEW · else SKIP |

The rubric is data, not code: each target role is a JSON description (`descriptions/*.json`) carrying the profile block, core stack, thresholds, queries and exclusions. Adding a role means adding a file.

## Quick start (offline, synthetic data)

Requires **Node 24+** (uses the built-in `node:sqlite`; no native modules).

```bash
node fixtures/load.mjs      # seed 6 synthetic postings into jobs.sqlite
node pipeline.mjs report    # stats, top matches, verdict spread
node --test tests/smoke.mjs # smoke tests
```

Live discovery needs your own browser sessions and the platform flows documented in `docs/` (not shipped here). Configure the model endpoint and keys with environment variables:

| Variable | Meaning |
|---|---|
| `LLM_URL` | OpenAI-compatible `/chat/completions` endpoint |
| `LLM_MODELS` | comma-separated model chain, first entry preferred |
| `LLM_API_KEY` / `LLM_KEY_FILE` | API key, or a YAML file containing `api_key: '...'` |
| `JOBAPPLY_DATA_DIR` | where `jobs.sqlite` lives (default: repo folder) |
| `CV_PATH`, `MAIL_FROM`, `CANDIDATE_NAME/PHONE/LOCATION` | outreach identity |
| `OPERATOR_WHATSAPP` | destination for the review digest |
| `WAHA_COMPOSE` | WAHA docker-compose used by the WhatsApp path |
| `CHROME_PATH` | Chromium used by the isolated scraping/apply profiles |

## Repository layout

| Path | Role |
|---|---|
| `pipeline.mjs` | stage runner (`discover`, `enrich`, `score`, `report`, `all`) |
| `db.mjs` | SQLite ledger, idempotent migrations, auto-queue policy |
| `score.mjs` | gate evaluation + LLM verdict (streaming, JSON-validated) |
| `linkedin.mjs`, `infojobs.mjs`, `scrape-liposts.mjs` | source collectors |
| `answers.mjs` | screening-question resolution (answer bank + LLM, moderate defaults) |
| `apply-easy2.mjs`, `apply-infojobs.mjs`, `assisted-apply.mjs` | apply runners (consent-gated, capped) |
| `cdp2.mjs`, `real-click.mjs`, `os-click.mjs`, `os-mouse.ps1` | browser driving over raw CDP |
| `outreach.mjs`, `send-emails.mjs`, `send-digest.mjs` | contact extraction + outreach channels |
| `verify-gmail.mjs` | submission verification via confirmation email |
| `descriptions/` | one JSON per target role |
| `docs/` | runbooks: Easy Apply, offsite ATS, InfoJobs, post scraping |
| `fixtures/`, `tests/` | synthetic data + smoke tests |

## Documentation

- `EASY-APPLY-PROCEDURE.md` — modal flow, question navigation, verification.
- `OFFSITE-APPLY-PROCEDURE.md` — ATS link decoding, open forms vs account-gated portals.
- `INFOJOBS-APPLY-PROCEDURE.md` — one-click apply, killer questions, page-state verification.
- `POSTS-JOBS-RECON.md` — what a feed-post source can and cannot tell you.
- `multi/README.md` — running several target-role profiles side by side.

## Not included (by design)

Browser profiles and cookies, the real ledger, the answer bank, personal résumés, API keys, and any scraped personal data. The pipeline expects you to supply your own sessions and identity through the variables above.

## License

MIT — see `LICENSE`.
