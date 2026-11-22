# Nightingale-72h-build-HZ

**EHR clinical intelligence** for acute care teams: a risk-sorted **patient worklist** maintained by an **automatic risk triage agent**, an **AI handover agent** whose every statement quotes its source note, a Glance top card, a longitudinal Timeline, versioned care notes, deterministic risk highlighting and an unresolved-action workflow — with password accounts, invitations, clinic-scoped RBAC and PHI redaction on the server.

This is a **judge-ready** application manual for the repository. Implementation detail beyond this page lives in [docs/TECHNICAL_BRIEF.md](./docs/TECHNICAL_BRIEF.md). Open-source licenses are listed in [ATTRIBUTION.txt](./ATTRIBUTION.txt).

---

## Architecture overview

Nightingale is a Next.js **App Router** app. The browser talks to Route Handlers under `app/api/*`, which call `src/lib/api/handlers.ts`. Prisma maps a **SQLite** file (`prisma/dev.db`) into typed models (`CareEntry`, `Highlight`, `CareAction`, `EntryRevision`, `AuditLog`, …). The client never imports `src/lib/db.ts` (guarded with `server-only`).

| Layer | Choice in this repo |
| --- | --- |
| Framework | Next.js 15 (App Router), React 19, TypeScript |
| Styling | Custom CSS (`app/globals.css`) — **not** Tailwind CSS |
| Icons | Inline SVG — **not** Lucide React |
| Data | Prisma 6 + SQLite |
| Agents | Anthropic SDK Tool Runner (`@anthropic-ai/sdk`) with strict zod tools, budgets and an outcome taxonomy; deterministic guardrails and safety floors |
| Auth | Email + password (scrypt), signed HttpOnly session cookies with revocation, invitations, lockout, rate limits, CSRF origin checks, security headers |
| Evaluation | `evals/`: pass@k / pass^k, triage metrics (under-triage, sensitivity, weighted kappa), case-clustered intervals, paired permutation tests |
| Tests | Vitest 3 + Testing Library + jsdom |
| i18n | Five locales (`en`, `zh`, `fi`, `de`, `fr`) |

Primary surfaces:

| Route | Role |
| --- | --- |
| `/login`, `/register`, `/activate` | Sign in; patient self-registration with a clinic code; one-time activation for invited staff |
| `/patients` | Worklist sorted by risk level and review window, with level counts, search and filters; **Add to database**: a new patient (optionally with a first note) or a note for an existing patient, which triggers the automatic risk assessment (staff / clinicians / admins) |
| `/glance` | Risk triage panel and AI handover summary (staff / clinicians), recency score, consultation progress, highest-risk highlights, unresolved / resolved actions |
| `/timeline` | Same glance card plus encounter list, note details, revision history, inline highlights |
| `/note-editor` | Create and patch notes (optimistic `baseVersion`, 409 on conflict) |
| `/search` | Chronological / relevance search over RBAC-filtered notes |
| `/account` | Profile, change password, sign out of all devices |
| `/admin/users` | Invite staff, issue activation links, enable / disable accounts (admins) |

Every page except `/login`, `/register` and `/activate` requires a session (`middleware.ts` redirects to `/login?next=…`). `POST /api/auth/login` issues an HMAC-signed, HttpOnly session cookie; every API route resolves the user from it (`requireActor`: signature, expiry, session version, account status, same-origin check). Details: [docs/SECURITY.md](./docs/SECURITY.md).

```
Browser (CareShell: session from /api/auth/me, cookie only)
        │
        ▼
middleware.ts (page gate)  ·  App Router  app/api/*  →  handlers.ts / auth-handlers.ts
        │
        ├── Auth          src/lib/auth/  (accounts, password, session, rbac)
        ├── PHI           src/lib/security/redact.ts
        ├── Notes         src/lib/care-note/entries.ts, revision.ts   ──▶ enqueue risk assessment
        ├── Glance        src/lib/care-note/glance.ts, CareAction
        ├── Highlights    keyword-highlights.ts, highlights.ts
        ├── Agents        src/lib/agent/core (SDK Tool Runner) · shared (record tools, citations)
        │                 risk/ (queue → agent → floor → RiskAssessment) · handover/
        └── Prisma        src/lib/db.ts  →  prisma/dev.db
```

---

## Agents

Both agents run on one platform (`src/lib/agent/core`): the Anthropic SDK Tool Runner with strict zod tools, a terminal submit tool, iteration / token / deadline budgets and a distinct outcome for every way a run can end. Their tools are bound to one patient and read through the same RBAC-checked accessors as the UI. Deterministic code checks every quote the model cites and applies a safety floor the model cannot lower.

**Risk triage agent** (`src/lib/agent/risk/`). Every note write enqueues an assessment; the queue claims it atomically and runs it after the response. The agent reads the record as a non-login service account and submits a level (LOW → CRITICAL), a review window and cited drivers. The final level is `max(model level, rule floor)`: severe vitals, anaphylaxis and severe respiratory distress floor at CRITICAL, clinician-marked critical findings at HIGH, red-flag symptoms at MEDIUM. Without a model the floor alone is the assessment, labelled *Rules*. Clinicians can override with a reason (audited); nurses see the level and only the evidence their role may open.

**Handover agent** (`src/lib/agent/handover/`). Reads the record with the requesting user's permissions, writes a summary in which every line quotes its source note, may propose follow-ups (a clinician must accept them), and guarantees that critical findings are never downgraded.

| Piece | Where |
| --- | --- |
| Platform: Tool Runner wrapper, tool binding, budgets, trace | `src/lib/agent/core/` |
| Record tools `get_glance_cards`, `get_timeline`, `get_notes`; evidence ledger; citation checks | `src/lib/agent/shared/` |
| Risk: queue, service account, floor, guardrails, worklist, override | `src/lib/agent/risk/`, `app/api/patients/**/risk`, `PatientWorklist.tsx`, `RiskPanel.tsx` |
| Handover: tools, guardrails, proposals | `src/lib/agent/handover/`, `app/api/patients/[id]/handover`, `HandoverPanel.tsx` |
| Evaluation | `evals/` (`npm run eval`), `evals/risk/` (`npm run eval:risk`) |
| First live-API check | `npm run agent:live-check -- --yes` (one run per agent, prints cost) |

**Enable them:** set `ANTHROPIC_API_KEY` (default model `claude-opus-5-5`); or `NIGHTINGALE_AGENT_CLIENT=gemini` with `GEMINI_API_KEY` to run the same agents on Google Gemini through a transport adapter (synthetic data only on the free tier); or `NIGHTINGALE_AGENT_CLIENT=simulated` to demo with the offline rule policies (labelled, no language model). Without either, risk levels come from the rule floor and the handover panel explains that the agent is not configured. `NIGHTINGALE_AGENTS_ENABLED=false` switches every model call off. All settings: [.env.example](./.env.example).

Design: [docs/AGENT_DESIGN.md](./docs/AGENT_DESIGN.md). Measurement: [docs/EVALUATION.md](./docs/EVALUATION.md). Live-API test plan: [docs/API_TESTING.zh.md](./docs/API_TESTING.zh.md).

**Live results** (Gemini 2.5 Flash through the transport adapter, 2026-11-21/22): after one round of prompt optimisation, the risk agent (`risk-v2`) rates 96.4% of 84 trials at the exact level with **no under-triage**, including 7 holdout cases written after the tuning (rule floor alone: 46.4% exact, 50% under-triage). The handover agent (`handover-v4` with one citation-repair round) passes 97.5% of core runs and 95% of the challenge set, with 100% required-fact coverage and zero leakage; free-text quote errors are repaired or rejected, never shown ([EVALUATION.md](./docs/EVALUATION.md) §7.4).

---

## Quick start

**Prerequisites:** Node.js 18+ and npm 9+.

1. **Install**

   ```bash
   npm install
   ```

2. **Database** (creates / syncs `prisma/dev.db` from `prisma/schema.prisma`)

   ```bash
   npx prisma db push
   npx prisma db seed
   ```

3. **Develop**

   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000): you are sent to `/login`. Demo sign-in shortcuts appear when the server runs with `NIGHTINGALE_DEMO_MODE=true`.

4. **Tests**

   ```bash
   npx vitest run
   ```

   **209 / 209** tests pass on the current suite. Prefer `npm run test` or see **Test Suite & Compatibility Guide** below.

5. **Agent evaluations** (offline, no API key: harness self-tests on oracle and rule baselines)

   ```bash
   npm run eval:smoke
   ```

   ```bash
   npm run eval:risk:smoke
   ```

### Environment

Copy `.env.example` to `.env`. The only required value is:

```
DATABASE_URL="file:./dev.db"
```

In production also set `NIGHTINGALE_SESSION_SECRET` (at least 32 characters) and `NIGHTINGALE_PUBLIC_URL`; leave `NIGHTINGALE_DEMO_MODE` unset. Every other variable is optional and documented in `.env.example`.

Prisma CLI resolves the database URL relative to `prisma/`. The application Prisma client opens `prisma/dev.db` from the repo root (Windows-safe `file:C:/...` form).

### Demo accounts

`npx prisma db seed` provisions **Nightingale Demo Clinic** with ten patients, rule-based risk assessments for each, and these accounts (password `Nightingale-Demo-2026` for all):

| Role | Email | Name |
| --- | --- | --- |
| CLINICIAN | `clinician@nightingale.test` | Joe Zhou |
| STAFF | `staff@nightingale.test` | Museil Kamil |
| ADMIN | `admin@nightingale.test` | Avery Admin |
| PATIENT | `elena.rossi@nightingale.test` (and the other nine patients) | Elena Rossi |

Patients can self-register at `/register` with clinic code `NIGHTINGALE-DEMO-2026`. Staff accounts are created only by invitation (`/admin/users`). These credentials are for the demo database only.

To create your own administrator (kept out of the seed and the repository), run:

```bash
npm run admin:create -- --email you@example.org --password 'Your-Long-Passphrase-2026' --name "Your Name"
```

Re-running it for the same email resets the password, re-activates the account and signs out its old sessions.

---

## Test Suite & Compatibility Guide

Vitest 3 is the only test runner. Integration tests use **Prisma against SQLite** (`DATABASE_URL` → `prisma/dev.db`). UI tests (`tests/test_ui_refresh.test.ts`, `tests/test_risk_ui.test.ts`) use **jsdom** + Testing Library. All other files use the **node** environment (`vitest.config.ts`).

**Last verified:** 209 / 209 passing (`npx vitest run`), `tsc --noEmit` clean, `next build` passing.

### Why tests are single-threaded

SQLite grants a write lock per database file. Parallel Vitest workers on Windows (and often macOS/Linux CI) hit `SQLITE_BUSY` / `EPERM` rename of the query engine. The repo therefore sets:

- `fileParallelism: false`
- `maxWorkers: 1`

in `vitest.config.ts`. Do **not** enable Vitest file parallelism against the shared demo DB.

### npm scripts

| Command | What it does |
| --- | --- |
| `npm run test` | One-shot `vitest run` (CI / judges) |
| `npm run test:run` | Same as `npm run test` |
| `npm run test:watch` | Watch mode (`vitest`) |
| `npm run test:ui` | Only the jsdom UI contract file |
| `npx vitest run tests/test_rbac_scope.test.ts` | Single file |

Pass extra Vitest flags after `--`:

```bash
npm run test -- --reporter=verbose
npm run test -- tests/test_revision_history.test.ts
```

### Python bridge (`test_runner.py`)

For harnesses that shell out to Python rather than npm:

```bash
python test_runner.py
python test_runner.py -- tests/test_concurrent_edits.test.ts
python3 test_runner.py --reporter=verbose
```

Requires Node/npm on `PATH`. The script only forwards to `npm run test`; it does not duplicate assertions.

### Environment notes

| Platform | Notes |
| --- | --- |
| Windows | Use the same `file:C:/...` Prisma URL as the app. Close other processes holding `prisma/dev.db` (including a stuck `next dev`) if generate fails with `EPERM` on `query_engine-windows.dll.node`. |
| macOS / Linux | Same Vitest config; still keep `maxWorkers: 1` when sharing one SQLite file. |
| CI | `npm ci` → `npx prisma db push` → `npm run test` (or `python test_runner.py`). |

SQLite journals (`*.db-journal`, `*.db-wal`, `*.db-shm`), `.vitest-cache`, and `node_modules` are gitignored. Integration tests create ephemeral clinic/user rows and delete them in `afterEach`; they share the configured SQLite file but must not run in parallel.

Coverage map: RBAC (`test_rbac_scope`), role payloads, search isolation, keyword/manual highlights, provenance, CareAction, revisions, concurrency, progress engine, recency/decay, UI refresh, seed identities, i18n.

---

Prisma `Role` values are **`PATIENT`**, **`STAFF`**, **`CLINICIAN`**, and **`ADMIN`**. There is no `RESEARCHER` enum value in this build; operational “fourth role” privileges (full clinical read, clinic-wide tools) are **`ADMIN`**. Patients are isolated to their own `user.id`. All other actors must share the resource `clinicId`.

Enforcement is **server-side** in `src/lib/auth/rbac.ts` (UI hiding is not a security boundary).

| Capability | PATIENT | STAFF | CLINICIAN | ADMIN |
| --- | --- | --- | --- | --- |
| Own-record only | Yes | Clinic-scoped | Clinic-scoped | Clinic-scoped |
| Glance recency / risk / actions | Hidden | Yes | Yes | Yes |
| Worklist and risk level | No | Yes | Yes | Yes |
| Risk evidence from notes the role cannot open | — | Counted, not shown | Yes | Yes |
| Override risk level (with reason) | No | No | Yes | Yes |
| Invite / disable users | No | No | No | Yes |
| Timeline raw body | No | Staff notes; **not** unreleased clinician drafts | Yes | Yes |
| Patient-facing summary | After clinician **FINAL_SUMMARY** only | Yes | Yes | Yes |
| Internal comments | No | Yes | Yes | Yes |
| MODEL / AI-doctor highlights | No | No | Yes | Yes |
| Manual (`HUMAN`) highlights | No | Own/staff note text | Own/clinician note text | Yes |
| Create / edit notes | No | Staff notes only | Clinician notes (staff notes only with a revision snapshot) | Yes (snapshot rules for staff notes) |
| Unresolved actions: view | No | Yes | Yes | Yes |
| Unresolved actions: add / tag / resolve | No | Yes | Yes | Yes |
| Submit final summary | No | No | Yes | Progress engine as implemented |
| Revision history bodies | No | Metadata; bodies omitted for staff | Full | Full |

**Visual boundaries**

- Patients see consultation progress and released summaries; no glance risk stack, no action cards, no note editor, no highlight chips.
- Staff notes are badged as nursing notes; clinician notes as clinician notes. Staff cannot open clinician edit for another author’s clinician note.
- Unresolved action **Mark Resolved**, category tags, and **+ Add Action** render only for STAFF / CLINICIAN / ADMIN.

---

## Data redaction and privacy guardrails

This demo is **not** a certified HIPAA product. It implements deterministic guardrails intended to reduce accidental PHI leakage:

**Where `redactPhi` runs** (`src/lib/security/redact.ts`, token `[REDACTED]`):

- Care-note **body** on write / revision
- Highlight **excerpts** (model and human)
- Glance action **text**
- Search / timeline payloads that include clinical narrative

**Patterns stripped:** emails, Singapore NRIC/FIN, PRC resident IDs, SG/EU-style phone numbers, labeled or honorific names (including Chinese 患者/姓名 forms). Clinical allowlisted phrases (e.g. “Care Plan”) are not treated as names.

**Role demotion (not regex):** even unredacted storage is not returned to patients — timeline omits `body`, `comments`, `highlights`, `revisions`, `version`, `status`, `authorRole`, and recency. Glance omits risk highlights, unresolved actions, and recency for `PATIENT`.

**Audit logs** (`AuditLog.metadata`) store `userId`, `entryId`, `newVersion` — **not** note bodies or identifiers matched by `redactPhi`.

**Isolation:** `assertPatientIsolation` + `assertClinicScope` on glance, timeline, search, entries, highlights, and CareAction APIs.

---

## Clinical highlight rules and unresolved actions

Full deterministic spec: **[docs/CLINICAL_HIGHLIGHT_RULES.txt](./docs/CLINICAL_HIGHLIGHT_RULES.txt)** (v1.0).

### Five risk tiers (pastel UI)

| Tier | Floor | Typical terms | UI token (implemented in CSS) |
| --- | --- | --- | --- |
| Critical / high | CRITICAL | chest pain, shortness of breath, anaphylaxis, SPO2 &lt; 90% | Soft red |
| Warning / medium | MEDIUM | fever, hyperpyrexia, tachycardic, acute confusion | Soft amber |
| Info / meds & allergies | LOW | penicillin, insulin, metformin, … | Soft green |
| Unresolved actions | ACTION_REQUIRED | pending echo, follow-up, STAT CT | Soft blue |
| Patient insights | LOW | nausea, insomnia, dizziness, fatigue | Soft purple |

**NegEx (spec):** do not auto-highlight a phrase preceded within 1–5 words by `no`, `denies`, `negative for`, `without`, `ruled out`. **Historical demotion:** `history of` / `past history` / `family history of` → INFO / LOW.

**Deduping:** first occurrence only in a note; longest-match-first (`chest pain` wins over `pain`); low-signal blacklist (`pain`, `cough`, `normal`, `well`) unless qualified.

**Provenance:** auto spans use `source=MODEL` (tooltip: auto-detected). Clinician/staff selection uses `source=HUMAN` and **overrides** overlapping model marks.

Runtime matcher: `src/lib/care-note/keyword-highlights.ts` (local keyword NER, not a remote LLM). Manual create: `POST /api/entries/[id]/highlights`.

### CareAction workflow

Persisted model `CareAction` (`PENDING` | `RESOLVED`).

| Step | Behavior |
| --- | --- |
| **Create** | STAFF/CLINICIAN **+ Add Action** → `POST /api/patients/{id}/actions` |
| **Tag** | Category `plan` / `comment` / `lab_order` / `follow_up` (plus derived `highlight`) via PATCH |
| **Resolve** | **Mark Resolved** stores `resolvedAt`, `resolvedByRole`, resolver user |
| **History** | Collapsed “Resolved actions history” on Glance; derived plan/comment/highlight lines stay open until resolved (upsert by `sourceKey`) |

Glance still **derives** pending items from `Plan:` / `Todo:` lines, follow-up-like comments, and action-labeled highlights, then merges stored rows.

---

## Testing and integrity

See **[Test Suite & Compatibility Guide](#test-suite--compatibility-guide)** for runners, SQLite locking, and `test_runner.py`.

| Command | Result |
| --- | --- |
| `npm run test` or `npx vitest run` | **209 / 209** passing |
| `npm run typecheck` | 0 errors |
| `npm run build` | passes |
| `npm run eval:smoke` | oracle 100%, null baseline passes only the empty case |
| `npm run eval:risk:smoke` | oracle matches gold on every case; the floor never lowers a level |

Coverage includes:

- RBAC section matrix and write/edit assertions (`tests/test_rbac_scope.test.ts`)
- Patient vs staff vs clinician timeline/glance payloads (`tests/test_role_data_scope.test.ts`)
- Clinic / patient isolation and search (`tests/test_search_patient_scope.test.ts`)
- Local keyword highlights and manual highlight APIs
- CareAction create / retag / resolve (`tests/test_actions.test.ts`)
- Concurrent edits, revision uniqueness, progress engine, recency/decay
- UI refresh of glance after save; revision-history table without internal comments
- Seeded 10 patients, demo accounts and rule-based risk assessments
- Accounts: passwords, lockout, sessions and revocation, invitations, registration, rate limits, CSRF (`tests/test_session_auth.test.ts`)
- Agent platform on the real SDK Tool Runner driven by a scripted transport (`tests/test_agent_core.test.ts`)
- Risk triage: floor, guardrails, queue, service account, override, per-viewer evidence (`tests/test_risk_agent.test.ts`, `tests/test_risk_ui.test.ts`), evaluation metrics (`tests/test_risk_eval.test.ts`)
- Handover agent: tools, RBAC, guardrails, persistence (`tests/test_handover_agent.test.ts`)
- i18n dictionaries (five locales)

---

## More documentation

- [docs/AGENT_DESIGN.md](./docs/AGENT_DESIGN.md) — agent platform, risk triage agent, handover agent: tools, permission boundary, floors, guardrails, failure modes
- [docs/EVALUATION.md](./docs/EVALUATION.md) — evaluation method, statistics, baseline results for both agents
- [docs/SECURITY.md](./docs/SECURITY.md) — accounts, sessions, authorization, browser protections, PHI, known gaps
- [docs/API_TESTING.zh.md](./docs/API_TESTING.zh.md) — live-API test plan with cost gates (Chinese)
- [docs/LABEL_REVIEW.zh.md](./docs/LABEL_REVIEW.zh.md) — frozen core vs challenge sets, blind clinician label review and agreement (Chinese)
- [docs/UPGRADE_PLAN.zh.md](./docs/UPGRADE_PLAN.zh.md) — upgrade plan (Chinese)
- [docs/TECHNICAL_BRIEF.md](./docs/TECHNICAL_BRIEF.md) — architecture, highlight engine, CareAction, RBAC, trade-offs
- [docs/CLINICAL_HIGHLIGHT_RULES.txt](./docs/CLINICAL_HIGHLIGHT_RULES.txt) — highlight ontology
- [ATTRIBUTION.txt](./ATTRIBUTION.txt) — third-party licenses
