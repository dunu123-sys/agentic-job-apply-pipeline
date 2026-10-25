# EASY APPLY — VERIFIED PROCEDURE (runbook)
> Mapped LIVE 2026-10-22 by driving the logged-in browser step by step
> (Dexian Brasil application submitted successfully through this exact flow).
> This is the authoritative procedure. apply-easy2.mjs codifies it.

## 1. The verified modal flow (LinkedIn Easy Apply, logged-in)

```
job page → [Easy Apply button] → PAGE 1/4 CONTACT (pre-filled from profile)
  → Next → PAGE 2/4 RESUME (profile copy pre-selected) → Next
  → PAGE 3/4 "Perguntas adicionais" (screening questions — ANSWER)
  → Review → PAGE 4/4 "Review your application" (verify everything)
  → [Submit application] → job page shows "Application status | Application submitted"
```
- Page indicator text lives in the modal: "3/4 pages" etc.
- NO follow-company checkbox appeared on the tested job.

## 2. Selector findings (all verified live — LinkedIn A/B obfuscates classes)

| What | How to find it | Do NOT rely on |
|---|---|---|
| Easy Apply button | `button[aria-label*="Easy Apply"]` / text "Easy Apply" | `.jobs-apply-button` — classes are `kxhldr kxhldq…`, renamed per session |
| The modal | NOT `[role=dialog]`, NOT `.jobs-apply-modal`. Heuristic: anchor = visible "Next"/"Submit application" button (or the input whose value contains the phone/email) → take its largest ancestor DIV (≤9 hops) = modal scope | any class/role selector |
| Step buttons | text match, **IN ENGLISH**: `Next`, `Review`, `Submit application`, `Back` (modal UI is EN even with pt-BR locale; questions stay PT) | "Avançar"/"Continuar" — walker v1 died here |
| Text inputs | `id` like `_r_2b_`; label via `aria-label` (PT question text). Fill with input+change events (`Object.getOwnPropertyDescriptor(proto,'value').set`) | `label[for]` (empty for radios) |
| Radio options (Yes/No) | option text = SIBLING `div > p` of the input's wrapper (e.g. `<p>Yes</p>`), NOT `label[for]` (rendered empty). Group question = the radio's `aria-label` | `label[for=id]` |
| Resume radio | pre-selected profile copy (Curriculo.pdf) — leave as-is unless operator profile changed | — |
| Salary fields | expect a NUMBER (`4000`). "A combinar" shows "Invalid input". A stale "Invalid input" can persist on screen even after a valid refill — **Review still advances**; submit succeeds | trusting the visible error text |

## 3. The two answer pipelines (operator spec 2026-10-22)

`answers.mjs` implements both:
1. **Resolve**: question → ① `answer-bank.json` fuzzy match (accent-stripped, `|`-separated patterns) → ② LLM (the configured router model via the router, streaming) grounded in RESUME.md with rules: PT, very short, resume-only facts, moderate when unknown ("good but not too good"), salary → number from bank, availability → profile (SP, remote/hybrid ok), years → count from resume dates rounded DOWN.
2. **Bank**: every LLM-resolved answer is auto-stored (source `auto`) and reused on any later matching question. Operator-set entries (source `operator`) take precedence and can be edited directly in the file. Uses counted per entry.
   - Salary is **4000** (operator-set, R$ 4.000 CLT).

## 3b. QUESTION NAVIGATION PLAYBOOK (everything learned, consolidated 2026-10-22)

The complete guide to every screening-question type seen across the 5 live
applications (Dexian, Shopee, Sempre IT, Apsen, Perform) + how to advance.

### 3b.1 The modal anatomy (all 5 jobs)
- Pages: **1 contact (prefilled)** → **2 resume (profile copy pre-selected)** →
  **3 "Perguntas adicionais" (the questions)** → **4 review**.
- Page indicator text: "N/4 pages" — read it to detect advancement.
- Buttons are ENGLISH even on pt-BR jobs: Next / Review / Submit application /
  Back / Edit. NEVER match PT ("Avançar") — that killed walker v1.
- Review page has "Edit" buttons per section (do not confuse with step buttons:
  step buttons live at the modal footer).
- Optional "Follow <company>" checkbox on the review page is PRE-CHECKED —
  uncheck it if the operator wants a low profile.
- Some jobs add extra text fields on page 1 (Perform: city typeahead) — a
  prefilled-looking page can still have a blocking required field.

### 3b.2 Question types and how to answer each (the core table)

| Type | How to detect | Answer vector | Traps |
|---|---|---|---|
| Years/experience text ("Há quantos anos…") | `input[type=text]` + aria-label question, counter N/20 | NUMBER as text ("6") — synthetic value-setter fill works | "anos" suffix OK to omit; keep ≤ 20 chars |
| Salary ("pretensão salarial…CLT") | same | NUMBER ("4000") — operator-set | "A combinar" = Invalid input; wants digits |
| Numeric-level ("nível de experiência…") | LOOKS like free text (type=text, 20-char counter) — but is **NUMERIC-ONLY** | NUMBER 1-5 scale (moderate = "3") | ALL text answers rejected ("Intermediário", "Basic", EN/PT — everything); this masquerade cost hours |
| Yes/No radios ("Você tem disponibilidade…") | 2 radio inputs sharing a `name` group; question = radio's `aria-label` | Resolve answer → map first word (Sim/Yes→yes, Não/No→no) → click option | Option text is in a SIBLING `<div><p>` (e.g. `<p>Yes</p>`), NOT in `label[for]` (renders empty); accept PT+EN option labels |
| Multi-option radios (Yes/No/other) | 3+ radios in a group | Same mapping; fall back to LLM choice if not yes/no | Never submit with required radios unanswered — LinkedIn silently refuses to advance |
| Location/city typeahead ("Enter city or location") | text field + a `listbox` appears after typing | Type → WAIT for listbox → CLICK a suggestion ("São Paulo, Brazil") | Typed text alone is invalid — Next is blocked until a suggestion is picked |
| File-upload question ("Tell me about your favorite project…") | question text + "Upload" button + hidden `input[type=file]` (0 file inputs in DOM until clicked) | Write a small answer file (resolver → uploads/) and upload it; or SKIP if not required | Optional ones can be skipped; do not click Upload without a file (native dialog can't be automated) |
| Resume selection (page 2) | radios labeled with resume files | Leave the pre-selected profile copy (Curriculo.pdf) unless operator says otherwise | Two files (Curriculo.pdf / Curriculum.docx) — profile copy is the right default |
| Contact fields (page 1) | name/phone/email/country | ALL prefilled from the LinkedIn profile — never touch | Prefilled values are valid; only fill empties |

### 3b.3 Filling mechanics — what works, what doesn't
- **Synthetic value-setter fill** (native `value` setter + input/change
  events) — works for ALL plain text fields, on all jobs. THE default.
- **Real keystrokes** (CDP key events / `keyboard type`) — needed for mask
  widgets (phone numbers); otherwise equal to synthetic.
- **DOM `.click()`** — works on SOME jobs' step buttons (Apsen), radios and
  checkboxes everywhere; FAILS on other jobs' step buttons (Perform).
- **Real CDP mouse click** (scrollIntoView + Input.dispatchMouseEvent) — works
  on ALL step buttons; REQUIRED below-the-fold (Review/Submit often are).
- **advanceClick pattern**: DOM click → verify state → real mouse click →
  verify. State check: `pg` changed / "Review your application" appeared /
  "Application submitted" appeared / modal disappeared.
- **scrollIntoView BEFORE any real click** — offscreen buttons swallow clicks
  silently (Perform's Review/Submit both needed it).

### 3b.4 The "Invalid input" semantics (learned the hard way)
- Can be **STALE RENDERING**: on Dexian the salary field kept showing it after
  a valid refill, yet Review advanced fine. Never trust the visual alone —
  TRY the advance; if it advances, the error was cosmetic.
- Can be **REAL**: if the same error returns after a Review attempt, the
  field's CURRENT value genuinely fails validation.
- **React state poisoning**: an over-limit answer (e.g. a 77-char LLM answer
  in a 20-char field) leaves the field failing "Invalid input" for EVERY
  later value — synthetic or real — until a **FRESH page load + modal
  reopen**. If a field rejects a value you are sure is valid, RELOAD the page
  and reopen the modal before concluding anything (this cost hours on Apsen).
- The char counter tells the truth: "N/20" tracks React state, not the DOM
  value. If the counter reflects your fill, React has it.

### 3b.5 Answer resolution order (the two pipelines, §3)
1. `answer-bank.json` fuzzy match (accent-stripped, first-match-wins,
   specific patterns before generic — bank ORDER matters).
2. LLM (the configured router model) grounded in RESUME.md — moderate answers
   ("good but not too good"), PT, very short; numbers for numeric-looking
   questions ("nível" → "3", never "Intermediário").
3. Every new answer auto-stores in the bank (source: auto) for reuse.
4. LinkedIn persists screening answers per job — a failed run still banks
   the answers; the next attempt starts with them prefilled (SQL=5/React=1
   survived a full session this way).

### 3b.6 The safe-failure properties (why automation is safe here)
- LinkedIn NEVER submits with required fields unanswered — the walker just
  stalls (page counter stops changing) and can be re-run after fixes.
- No submit happens without an explicit "Submit application" click, and
  (per the consent gate) not without --live + operator approval.
- Every walk is idempotent: reopening a job shows the saved answers and
  "already applied" jobs are auto-skipped.

## 4. How the browser is driven

- Persistent **headed** Chrome on `li-profile` + `--remote-debugging-port=9223`
  (launch: ms-playwright chromium-1248 chrome.exe with the profile as user-data-dir).
- Raw CDP over Node's built-in WebSocket (`cdp2.mjs`): commands `goto|state|dump|
  click|fill|pick|check|shot|opts|radio|eval`. Playwright's connectOverCDP FAILS
  on this Chrome build (30s handshake timeout) — raw WebSocket works.
- **CRITICAL (this host): `node` on PATH is an MSYS shim that dies with
  "stdin is not a tty" when run in the background (no tty). ALWAYS invoke
  `"C:/Program Files/nodejs/node.exe"` by full path for background jobs.**
- Rules: li-profile is HEADED-ONLY; verify login by the `li_at` cookie; pace
  ~3s between steps; caps 15/day, 5/hour; audit every send in `apply-audit.log`.

## 5. Verification of a submitted application

TWO independent channels (both must be checked):
1. **Job page**: reload → text contains `Application status` +
   `Application submitted` (or PT equivalents / "Applied" pill).
2. **Gmail (operator insight 2026-10-22)**: every successful apply triggers
   "Example Candidate, your application was sent to <COMPANY>" from
   jobs-noreply@linkedin.com. Check with:
   `gog gmail search "from:jobs-noreply@linkedin.com \"your application was sent\" newer_than:1d"`
   or run `node verify-gmail.mjs` (reconciles the approved queue vs Gmail).
Then: ledger `apply_status='applied-easy-apply'`, `outreach_status='applied'`,
`outreach_channels+='easyapply-live;'`, and a line in `apply-audit.log`.

## 6. State (2026-10-22, end of apply session)

**4 of 5 approved jobs APPLIED, each verified on-job-page AND by Gmail
confirmation email** ("Example Candidate, your application was sent to <company>",
from jobs-noreply@linkedin.com):

| Job | Status | Answers used |
|---|---|---|
| Dexian Brasil (4480237527) | ✅ applied | years=6, hybrid=Yes, salary=4000 |
| Shopee (4479370319) | ✅ applied | salary=4000, hybrid=Yes, plantões=Yes, SQL=Yes |
| Sempre IT (4479435036) | ✅ applied | PowerPlatform=3, commute=Sim, salary(auto) |
| Perform (4415712184) | ✅ applied | C#=Yes, React=Yes, SQLServer=Yes, city=São Paulo (typeahead!), follow=unchecked |
| Apsen (4477079591) | ✅ applied (22:42) | postgres=6, sql=5, react=1, csnet=6, APIs nível=3 (NUMERIC), salary=4000 |

Earlier probes clicked "Next" on Shopee/Dexian modals harmlessly (never submit).

## 7. Walker bugs found in the first LIVE batch + their fixes (2026-10-22)

1. **Radio answer mapping too strict** — bank/LLM answers like `"Sim, ..."` or
   PT option labels (`Sim`/`Não`) never matched. Fix: map by FIRST WORD of the
   answer (`norm(a).split(...)[0]`) and accept PT+EN option labels via
   `optionMatches()` (`yes/sim/y/s`, `no/nao/n`).
2. **Advancing clicks were document-wide** — the "Review" click hit a
   page-behind button (company reviews), so the walker looped pages 4-8 on
   "3/4 pages" without ever advancing. Fix: ALL step clicks (next/review/
   submit) are scoped to `(__modal()||document.body)` — modal only.
3. **Bank order matters** — `bankLookup` is first-match-wins. Specific
   patterns MUST precede generic ones (e.g. `power platform` → "3" BEFORE
   `anos de experiencia` → "6"; otherwise "Há quantos anos você usa Power
   Platform?" gets the .NET answer).
4. **LinkedIn never submits with unanswered required radios** — the failed
   batch left all 4 jobs unapplied, LinkedIn unharmed. Safe failure mode.
5. Background jobs on this host MUST use `"C:/Program Files/nodejs/node.exe"`
   (see §4) — the PATH `node` shim dies ("stdin is not a tty") and the whole
   first background batch silently did nothing.

## 7b. Second-round findings (same day, driving with agent-browser + CDP)

6. **LinkedIn A/B-tests modal interaction modes PER JOB.** Some modals only
   advance on DOM `.click()`, others only on REAL CDP mouse events
   (`Input.dispatchMouseEvent` after `scrollIntoView`). Fix in the walker:
   `advanceClick()` = DOM click → verify page state changed → fallback real
   mouse click → verify. Both Perform (real) and Apsen (DOM) proved this.
   `agent-browser` (`F:/Hermes/tools/agent-browser-.../agent-browser-win32-x64.exe`,
   `connect 9223`) gives real clicks + a11y snapshots — my interactive eyes/hands.
7. **Buttons below the fold need `scrollIntoView` before a real click** —
   Review/Submit clicks silently no-op'd until scrolled (Perform).
8. **Location fields are TYPEAHEADS**: typing is not enough, you must CLICK a
   suggestion from the listbox (Perform page-1 "Enter city or location";
   blocked Next until "São Paulo, Brazil" was picked).
9. **Screening text questions can have ~20-char limits** (counter "N/20").
   Long LLM answers overflow → "Invalid input". The bank now stores short
   values (e.g. APIs REST nível → "Intermediária"). Rule: keep screening
   text answers ≤ 20 chars unless the counter shows more.
10. **A stuck "Invalid input" artifact** can persist after fixing a field
    (stale React render). A FRESH modal (reload page → reopen) + short answer
    clears it. BUT if the error returns after a Review attempt, it is real.
11. **LinkedIn persists screening answers per job** (SQL=5/React=1 from run 1
    reappeared on the fresh modal) — failed runs are not lost work.
12. **RESOLVED — was NOT a validator bug** (Apsen, cracked 2026-10-22 with the
    operator): the "nível de experiência" question is NUMERIC-ONLY — every TEXT
    answer (Intermediário/Basic/…, EN or PT) is rejected as "Invalid input",
    while a NUMBER ("3") validates instantly. Two compounding traps:
    (a) the question LOOKS free-text (type=text, 20-char counter, no hint);
    (b) an over-limit answer (the 77-char LLM answer) POISONS the field's
    React state — every later value on that modal keeps failing "Invalid
    input" until a FRESH page load + modal reopen. On a fresh modal, a plain
    synthetic fill of the NUMBER works. Rule for the resolver: "nível de
    experiência" questions → answer as a NUMBER 1-5 (moderate = 3).
13. `advanceClick` state detection: compare `pg` (N/4 pages), presence of
    "Review your application", modal existence, and "Application submitted"
    BEFORE vs AFTER each click attempt — that's how dom/real/failed is decided.
14. Walker got a pageState regex bug from single backslashes inside a JS
    template literal (`\d` in file → runtime `d`): ALWAYS double them
    (`\\d`) in template literals, or the regex matches nothing/throws.

## 7c. Walker hardening after the Apsen case (2026-10-22)

15. `targets()` now also excludes `blocked` rows (validator-bug jobs are
    terminal for automation; a blocked job would otherwise be retried
    forever by every run).

## 8. STANDING UPDATE ORDER (every session touching jobapply)

Update in this order, every time:
1. `apply-audit.log` — one line per real external action (already automatic).
2. `jobs.sqlite` — ledger columns via markApplied/outreach code (automatic).
3. `EASY-APPLY-PROCEDURE.md` — new findings/fixes as numbered items.
4. `answer-bank.json` — auto-grows via the resolver; operator may edit values.
5. `SHIPPED.md` (.\) — append the session's
   shipped work at the end of each work session.
6. Skill `job-apply-pipeline` — durable procedure changes only.
