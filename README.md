# Nightingale-72h-build-HZ

**EHR clinical intelligence** for acute handover: a Glance top card, a longitudinal Timeline, versioned care notes, deterministic risk highlighting, and an unresolved-action workflow — with clinic-scoped RBAC and PHI redaction on the server.

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
| Tests | Vitest 3 + Testing Library + jsdom |
| i18n | Five locales (`en`, `zh`, `fi`, `de`, `fr`) |

Primary surfaces:

| Route | Role |
| --- | --- |
| `/glance` | Recency score, consultation progress, highest-risk highlights, unresolved / resolved actions |
| `/timeline` | Same glance card plus encounter list, note details, revision history, inline highlights |
| `/note-editor` | Create and patch notes (optimistic `baseVersion`, 409 on conflict) |
| `/search` | Chronological / relevance search over RBAC-filtered notes |

Demo authentication uses the `x-user-id` header. The header **Role** control (`PATIENT` / `STAFF` / `CLINICIAN`) verifies identity, then sets that header for API calls.

```
Browser (CareShell)
   x-user-id
        │
        ▼
App Router  app/api/*  →  handlers.ts
        │
        ├── RBAC          src/lib/auth/rbac.ts
        ├── PHI           src/lib/security/redact.ts
        ├── Notes         src/lib/care-note/entries.ts, revision.ts
        ├── Glance        src/lib/care-note/glance.ts, CareAction
        ├── Highlights    keyword-highlights.ts, highlights.ts
        └── Prisma        src/lib/db.ts  →  prisma/dev.db
```

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

   Open [http://localhost:3000](http://localhost:3000) (redirects to `/timeline`).

4. **Tests**

   ```bash
   npx vitest run
   ```

   **64 / 64** tests pass on the current suite. Prefer `npm run test` or see **Test Suite & Compatibility Guide** below.

### Environment

Copy `.env.example` if needed:

```
DATABASE_URL="file:./dev.db"
```

Prisma CLI resolves this relative to `prisma/`. The application Prisma client opens `prisma/dev.db` from the repo root (Windows-safe `file:C:/...` form).

### Demo login

`GET /api/demo` (and `prisma/seed.ts`) provision **Nightingale Demo Clinic**:

| Role | How to verify |
| --- | --- |
| STAFF | Employee code `00001` (Museil Kamil) |
| CLINICIAN | Employee code `00002` (Joe Zhou) |
| PATIENT | e.g. Elena Rossi, phone `555-010-1001`, DOB `1984-03-12` |

Secondary verification for staff/clinician is the same digit string as the employee code.

---

## Test Suite & Compatibility Guide

Vitest 3 is the only test runner. Integration tests use **Prisma against SQLite** (`DATABASE_URL` → `prisma/dev.db`). UI tests in `tests/test_ui_refresh.test.ts` use **jsdom** + Testing Library. All other files use the **node** environment (`vitest.config.ts`).

**Last verified:** 64 / 64 passing (`npx vitest run`).

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
| `npm run test` or `npx vitest run` | **64 / 64** passing |

Coverage includes:

- RBAC section matrix and write/edit assertions (`tests/test_rbac_scope.test.ts`)
- Patient vs staff vs clinician timeline/glance payloads (`tests/test_role_data_scope.test.ts`)
- Clinic / patient isolation and search (`tests/test_search_patient_scope.test.ts`)
- Local keyword highlights and manual highlight APIs
- CareAction create / retag / resolve (`tests/test_actions.test.ts`)
- Concurrent edits, revision uniqueness, progress engine, recency/decay
- UI refresh of glance after save; revision-history table without internal comments
- Seeded 10 patients + Museil Kamil / Joe Zhou
- i18n dictionaries (five locales)

---

## More documentation

- [docs/TECHNICAL_BRIEF.md](./docs/TECHNICAL_BRIEF.md) — architecture, highlight engine, CareAction, RBAC, trade-offs
- [docs/CLINICAL_HIGHLIGHT_RULES.txt](./docs/CLINICAL_HIGHLIGHT_RULES.txt) — highlight ontology
- [ATTRIBUTION.txt](./ATTRIBUTION.txt) — third-party licenses
