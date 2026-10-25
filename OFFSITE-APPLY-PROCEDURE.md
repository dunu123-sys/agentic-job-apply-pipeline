# OFFSITE (NON-EASY-APPLY) — PROCEDURE & FINDINGS
> Explored live 2026-10-22 by driving the logged-in browser (same persistent
> Chrome + CDP :9223 setup as the Easy Apply runbook — see EASY-APPLY-PROCEDURE.md §4).
> Test cases: Webmotors (score 88, InHire ATS) + Strada (score 85, RH Gestor ATS).
> Companion to EASY-APPLY-PROCEDURE.md — read §4 there first for the driving tools.

## 1. The entry point: finding where a non-EA job actually applies

LinkedIn non-EA jobs show **"Apply on company website"** (an `<a>`, not a button).
Its href is LinkedIn's safety redirect:

```
https://www.linkedin.com/safety/go/?url=<URL-ENCODED-REAL-TARGET>
```

Decode it to get the real ATS URL (works from a logged-out page too):
```js
[...document.querySelectorAll('a,button')]
  .filter(e => /apply on company website/i.test((e.getAttribute('aria-label')||'')+' '+(e.textContent||'')))
  .map(e => decodeURIComponent(new URL(e.href).searchParams.get('url')))
```
⚠️ Write the test as ONE string concat INSIDE test() — `test(x)+' '+y` binds
the `+` after test() and matches everything (cost me one bad probe).

Store the decoded URL in the ledger (`apply_url`) + the ATS name in
`apply_method` — future runs can route by ATS without re-probing.

## 2. TWO categories of offsite ATS (the big discovery)

### Category A — open public form (e.g. InHire: webmotors.inhire.app)
Multi-step form anyone can fill. Automatable per-ATS with quirks (see §3).
Other known open-form ATS families: Gupy, Lever, Greenhouse (external mode),
Workable — each needs its own mini-playbook; do NOT assume one walker fits all.

### Category B — ACCOUNT-GATED (e.g. RH Gestor: stradalog.rhgestor.com.br)
The vacancy page has NO form. Apply requires a platform account:
"Criar meu currículo" (register) or "Já tenho conta" (login).
→ One-time account seeding per platform, then future applies reuse the login
(the same pattern that made LinkedIn Easy Apply automatable).
→ Until an account exists, route these jobs to the operator with the link +
"Criar currículo primeiro" — do NOT try to automate registration blind
(name/email/CVV-grade data; registration flows also often have email-verify
loops that need the operator anyway).

## 3. InHire ATS deep-dive (Webmotors) — field map + widget behaviors

Form structure (multi-step: "1. Information", "2. Diversity", then review;
language switcher EN/PT in the header — pick Português [BR] first, the form
labels translate instantly).

Step 1 fields (all marked * required):
- Full name, CPF (masked 000.000.000-00; "I'm not Brazilian" checkbox skips it),
  email, cell phone with country, LinkedIn profile URL
- Country of origin, City (DISABLED until country chosen)
- Hybrid-availability Yes/No radio
- Resume file upload ("Attach resume")
- "Salary as employee" (free text)
- One Yes/No pre-checked (diversity block)
- Next button [disabled] until required fields complete

### What worked / what did NOT (verified live, 20+ probes)

| Interaction | Works? | How |
|---|---|---|
| Plain text fields (name, email, LinkedIn, CPF) | ✅ | native value-setter + input/change events (the standard React fill) |
| Real keystrokes (`keyboard type` / Backspace) | ✅ | needed for the phone mask widget |
| agent-browser `fill` on the phone mask input | ❌ | controlled component ignores it (value reverts) |
| `react-dropdown-select` country widget — open via a11y ref click | ❌ | click lands, aria-expanded stays false |
| same widget — open via synthetic pointer/mousedown sequence | ❌ | ignored (wants trusted events) |
| same widget — trusted CDP mouse click (real-click.mjs pattern) | ⚠️ | opened ONCE unreliably; not reproducible |
| widget search box typing | ❌ | value goes in, list never filters |
| wheel-scroll the virtualized list to reach "Brasil" | ❌ | synthetic WheelEvent ignored |
| phone field with typed `+55…` full number | ⚠️ | digits accepted but mask keeps the +1 prefix until the country is picked |

**Practical recipe for InHire (semi-automated):**
1. Fill every plain text field via the value-setter (works, ~2s/field).
2. Upload the resume via the Attach-resume file input (CDP DOM.setFileInputInputs
   or agent-browser `upload`).
3. Country dropdown + phone prefix: **operator does these two clicks manually**
   (~10s) — the widget defeats every synthetic vector; do not burn more time on it.
4. City unlocks after country; salary/hybrid/diversity are simple.
5. STOP before submit → operator reviews → submit.

**Missing data point: the operator's CPF.** InHire requires it (Brazilians).
It is NOT in config/RESUME anywhere. Ask the operator once and store it in
`answer-bank.json` (pattern "cpf") — future InHire/Gupy applies need it.
CPF validation also runs a checksum (mask alone won't pass real submission).

## 4. RH Gestor (Strada) — account-gated

- Vacancy page renders fine logged-out: title, requirements, benefits.
- No form at all — only "Criar meu currículo" / "Já tenho conta".
- Route: operator seeds one RH Gestor account (email-verified), profile/CV
  saved on the platform; after that, applies become form-submits.

## 5. Routing rule for the pipeline (recommendation)

```
non-EA job → decode safety/go URL → identify ATS by domain:
  inhire.app        → InHire playbook (§3, semi-automated, needs CPF)
  rhgestor.com.br   → account-gated: operator link until account seeded
  gupy.io / gupy.com.br → likely account-gated too — probe when first seen
  lever.co / greenhouse.io / workable.com → open form — build per-ATS mini-playbook
  unknown           → snapshot the page once, classify A/B, record apply_method
```
Ledger columns already exist: `apply_method` (ATS id) + `apply_url` (decoded).
Set them during enrichment so the APPLY tab can badge the route and the
operator sees "needs account" vs "formfillable" at a glance.

## 6. Files & tools added in this exploration

- `real-click.mjs` — trusted CDP mouse click at an element (CDP_TAB=<substr>
  selects the tab; works on any ATS page, not just LinkedIn).
- `cdp2.mjs` now takes `CDP_TAB=<url-substring>` env to aim at a non-LinkedIn tab.
- `uploads/` dir created (answer files for upload-type questions).

## 7. Open items for the operator (decisions, not agent work)

1. Provide CPF (once) → goes in the answer bank.
2. Approve the semi-automated InHire flow (automation fills, operator does the
   country dropdown + submits) — or accept "fill only, I take it from there".
3. Decide whether to seed accounts on RH Gestor/Gupy (one-time, email-verified).
4. No non-EA application has been submitted yet — Webmotors sits filled-not-
   submitted; nothing leaves the browser until the operator says go.
