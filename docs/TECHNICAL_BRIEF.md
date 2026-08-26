# Technical Brief — Nightingale Clinical Intelligence

**Audience:** judges and reviewers  
**Stack:** Next.js 15 App Router · React 19 · TypeScript · Prisma 6 / SQLite · Vitest  
**Companion spec:** [CLINICAL_HIGHLIGHT_RULES.txt](./CLINICAL_HIGHLIGHT_RULES.txt)

---

## 1. Executive summary and system architecture

Nightingale is a **clinic-scoped EHR intelligence layer** for handover, not a full HIS. It answers three questions in one session: *what is highest risk right now* (Glance), *what happened over time* (Timeline), and *what is still open* (CareAction). Notes are versioned, highlights are offset-addressable, and patients never receive raw narrative or internal commentary.

Clinical “AI” in this build is a **deterministic local phrase engine** plus optional human spans. There is **no outbound LLM** on the highlight path. That keeps P95 glance/timeline work on the local SQLite + in-process cache path and avoids hallucinated risk labels.

```
┌─────────────────────────────────────────────────────────────────┐
│  Client (CareShell)                                             │
│  /glance  /timeline  /note-editor  /search                      │
│  Glance cards · Timeline list · Note Details modal              │
│  Revision History table · Highlight composer (HUMAN)            │
│  Role gate → x-user-id on every fetch                           │
└───────────────────────────────┬─────────────────────────────────┘
                                │ HTTPS / same-origin JSON
┌───────────────────────────────▼─────────────────────────────────┐
│  Next.js App Router  app/api/*  →  src/lib/api/handlers.ts      │
│  requireActor · RBAC · isolation · 409 ConflictError            │
│  Server-only modules (Prisma never imported from Client)        │
└───────┬─────────────────┬───────────────────┬───────────────────┘
        │                 │                   │
        ▼                 ▼                   ▼
┌───────────────┐ ┌───────────────┐ ┌─────────────────────────────┐
│ Highlight &   │ │ Redaction     │ │ Prisma ORM                  │
│ NER engine    │ │ redactPhi()   │ │ Clinic → User → CareEntry   │
│ keyword-      │ │ write + read  │ │   ├─ EntryRevision          │
│ highlights.ts │ │               │ │   ├─ Highlight (MODEL/HUMAN)│
│ HUMAN overlay │ │               │ │   ├─ Comment                │
│ in renderer   │ │               │ │   └─ CareAction             │
└───────────────┘ └───────────────┘ │ SQLite  prisma/dev.db       │
                                    └─────────────────────────────┘
```

Warm Glance uses a process-local `Map` (`patientId:role`). Mutations invalidate it. A client event bus refreshes Glance/Timeline/Search for **that patient only**.

---

## 2. Core clinical intelligence engine

Normative rules live in **[docs/CLINICAL_HIGHLIGHT_RULES.txt](./CLINICAL_HIGHLIGHT_RULES.txt)** (v1.0). Runtime matching is `src/lib/care-note/keyword-highlights.ts`; persistence is `Highlight` with `source` `MODEL` | `HUMAN`.

### Five risk tiers

| Functional bucket | Risk floor | Pastel intent | Example lexicon |
| --- | --- | --- | --- |
| Critical symptoms / severe vitals | CRITICAL | Soft red | chest pain, shortness of breath, anaphylaxis |
| Abnormal labs / fever / moderate vitals | MEDIUM | Soft amber | hyperpyrexia, fever, tachycardic |
| Medications & allergies | LOW | Soft green | penicillin, insulin, metformin |
| Unresolved actions | ACTION_REQUIRED | Soft blue | pending echo, follow-up, STAT CT |
| Patient insights | LOW | Soft purple | nausea, insomnia, dizziness |

Tiers are **floors**, not a sixth “severity slider.” The UI maps labels through `risk-tone.ts` so staff are not trained on a rainbow of one-off colors.

### NegEx and historical demotion (spec)

The written spec requires:

- **Negation window:** skip a match if a trigger (`no`, `denies`, `negative for`, `without`, `ruled out`) appears within **1–5 words** before the phrase. Example: “Patient denies chest pain” must not light `chest pain`.
- **Historical demotion:** `history of` / `past history` / `family history of` drop the span to INFO / LOW.

Judges should treat that file as the **clinical contract**. The current matcher already encodes the **mechanical** half of alert-fatigue control (below); NegEx/history are specified for the same engine so later lexicon expansion stays deterministic rather than prompt-shaped.

### Deterministic resolution (implemented)

1. **Longest-match-first** — phrases are applied longest first; overlapping shorter tokens (`pain` vs `chest pain`) lose.
2. **First occurrence** — after scan, duplicate excerpts in the same body are dropped.
3. **Low-signal blacklist** — standalone generic terms (`cough`, `fatigue`, `headache` in code; spec also lists `pain`, `normal`, `well`) are suppressed unless a longer/severe phrase already won.

MODEL highlights are written on note create/patch. They do not replace clinician judgment.

### Precedence: HUMAN over MODEL

`HighlightedNoteBody` assigns covering spans by source, then tone. Any **HUMAN** span that overlaps a MODEL span **wins visually and semantically**. Manual capture is `POST /api/entries/[id]/highlights` from Timeline or the enlarged Note Details modal (text selection → `source=HUMAN`). Tooltips distinguish auto-detect vs manual.

---

## 3. Data model and schema relationships

Tenant: `Clinic`. People: `User` (`role`, optional `clinicId`). A **patient** is a `User` with `role=PATIENT`. Notes hang off that user as `CareEntry.patientId`.

```
Clinic
  └── User (PATIENT | STAFF | CLINICIAN | ADMIN)
        │
        ├── CareEntry (as patient)          authored by STAFF/CLINICIAN User
        │     ├── EntryRevision[]           @@unique(careEntryId, version)
        │     ├── Highlight[]               offsets, excerpt, source, label
        │     ├── Comment[]                 internal thread
        │     ├── CareEntryViewer[]         progress-engine views
        │     └── CareAction[]              closed-loop tasks
        └── CareAction (createdBy / resolvedBy)
```

**Highlights** belong to a note (and optionally a revision). Glance ranks a subset as “highest risk” using label/confidence plus learned `FeatureWeight` scores.

**CareAction** is the closed loop (not a free-text TODO in the note body):

| Stage | Mechanism |
| --- | --- |
| Create | `POST /api/patients/{id}/actions` — kind + redacted text, attached to latest or chosen `CareEntry` |
| Derive | Glance also lifts `Plan:` / `Todo:` lines, follow-up-like comments, and action-labeled highlights; `sourceKey` is comment id, highlight id, or `{entryId}:plan` |
| Tag | PATCH `kind`: `plan` \| `comment` \| `lab_order` \| `follow_up` (derived `highlight` retained until retagged) |
| Resolve | PATCH `status=RESOLVED` — `resolvedAt`, `resolvedById`, `resolvedByRole` |
| Audit | `AuditLog` actions `CARE_ACTION_CREATE` / `UPDATE` / `RESOLVE` without body PHI; Glance **Resolved actions history** is the clinician-facing trail |

Upsert-on-first-mutate means resolving a derived plan line materializes a row and **hides** it from the pending list without deleting the note.

---

## 4. Security, privacy, and RBAC

**Auth (demo):** `x-user-id` must be a real `User.id`. This is not production SSO.

**Boundaries:** `assertClinicScope` (clinic mismatch → 403). `assertPatientIsolation` (patients may only address their own id). UI hiding is **not** the control.

### Matrix

| | PATIENT | STAFF | CLINICIAN | ADMIN |
| --- | --- | --- | --- | --- |
| Record scope | Self | Clinic | Clinic | Clinic |
| Raw note / comments / MODEL doctor highlights | No | Comments + staff-visible notes; no unreleased clinician drafts; no AI-doctor MODEL | Yes | Yes |
| Glance risk, recency, actions | No | Yes | Yes | Yes |
| Write notes | No | Staff notes only | Clinician notes; staff notes only with revision snapshot | Privileged + snapshot rules |
| CareAction mutate | No | Yes | Yes | Yes |
| Final summary release | No | No | Yes | As implemented in progress engine |

### PHI / PII

`redactPhi` (`src/lib/security/redact.ts`) is **deterministic**: same input → same `[REDACTED]` output. Applied on **write** (note body, excerpts, action text) and **read** (timeline/glance snippets). Patterns include emails, SG NRIC/FIN, PRC 18-digit IDs, SG/EU phones, honorific and labeled names (including 患者/姓名).

**Role mask** is separate from regex: patient JSON omits `body`, `comments`, `highlights`, revision bodies, recency, and action lists. Patient-facing summary is empty until consultation stage `FINAL_SUMMARY`.

`AuditLog.metadata` is an allowlist (`userId`, `entryId`, `newVersion`, …) — **never** the note text.

---

## 5. Architectural trade-offs

### Trade-off 1 — Local deterministic NER vs external LLM

| | Local rules (`findLocalRiskPhrases`) | Remote LLM |
| --- | --- | --- |
| Latency | In-process; Glance designed for **P95 &lt; 300 ms** on warm cache + SQLite | Network + token wait; tail latency unbounded |
| False positives | Bounded by lexicon, longest-match, first-hit, blacklist | Fluent but **non-reproducible** labels; risk of invented “chest pain” |
| PHI | No third-party prompt | Would require a BAA and egress review |
| Explainability | Spec + offsets + provenance pointer | Opaque |

We accepted **incomplete recall** (missed rare phrasing) in exchange for **zero generative false-positive risk** on the auto-highlight path. Clinicians close the recall gap with HUMAN spans. Keyword `FeatureWeight` learning (PIN/EDIT) is a small, local ranking tweak — not a second model.

### Trade-off 2 — Compact revision history vs comment-stuffed modal

Revision History is a **chronological table**: timestamp · editor name and role · summary or body diff. Internal/staff comments remain on the **timeline thread**, not duplicated under versions.

**Why:** version audit answers “who changed the note and to what.” Mixing comments into that modal created a second, unsorted inbox and failed the “scan in one breath” test for MDT. The cost is one extra glance at the timeline for commentary — acceptable versus burying diffs under handoff chatter.

---

## 6. Quality assurance and verification

### Test suite & compatibility guide

| Item | Detail |
| --- | --- |
| Runner | **Vitest 3** (`vitest.config.ts`) |
| Default env | **node** — Prisma SQLite integration (`tests/**/*.test.ts`) |
| UI env | **jsdom** — `tests/test_ui_refresh.test.ts` (Testing Library) |
| Parallelism | `fileParallelism: false` and `maxWorkers: 1` so one SQLite file is not write-locked by concurrent workers (especially Windows) |
| Last count | **64 / 64** passing |

**npm**

```bash
npm run test          # vitest run (CI)
npm run test:run      # alias
npm run test:watch    # vitest watch
npm run test:ui       # jsdom UI file only
npm run test -- tests/test_rbac_scope.test.ts
```

**Python bridge** (forwards to npm; Node must be on `PATH`)

```bash
python test_runner.py
python test_runner.py -- tests/test_revision_history.test.ts
```

Do not run Vitest with file-level parallelism against `prisma/dev.db`. If Windows `prisma generate` fails with `EPERM` renaming `query_engine-windows.dll.node`, stop other Node processes using that engine, then retry.

Representative map:

| Area | Tests |
| --- | --- |
| RBAC / isolation | `test_rbac_scope`, `test_role_data_scope`, `test_search_patient_scope` |
| Clinical highlights | `test_local_keyword_highlights`, `test_manual_highlights`, `test_highlight_provenance` |
| CareAction loop | `test_actions` |
| Integrity | `test_revision_history`, `test_concurrent_edits`, `test_progress_engine`, `test_decay`, `test_recency` |
| UI contracts | `test_ui_refresh` (glance refresh; revision dialog without internal comments) |
| Seed / i18n | `test_seed_patients`, `test_i18n` |

This brief describes the **shipped** architecture. Demo `x-user-id` auth must be replaced before any live PHI deployment.
