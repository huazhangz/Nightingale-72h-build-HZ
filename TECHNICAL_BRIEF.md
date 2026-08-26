# Nightingale-72h-build-HZ — Technical Brief

Single-page care-note and longitudinal timeline engine: clinic-scoped RBAC, PHI redaction, immutable revisions, provenance pointers, concurrent-edit merge, in-memory glance cache, and keyword self-learning from highlight feedback.

Stack in this repository: **Next.js 15 (App Router)**, **React 19**, **TypeScript**, **Prisma 6 + SQLite**, **Vitest**. UI styling is custom CSS (`app/globals.css`), not Tailwind.

---

## 1. Goals

- Fast **glance** (top card) and **timeline** for handover.
- Notes are versioned; revert restores historical body and records an audit row.
- Highlights carry a **provenance pointer** (`entryId#start-end`) that resolves to an exact substring.
- Staff and clinicians may edit the same note concurrently: **clinician wins conflicts**, losing text is snapshotted.
- Patients see only patient-facing summaries; internal comments and raw notes are stripped server-side.

---

## 2. Runtime topology

```
Browser (CareShell + pages)
  x-user-id header
        │
        ▼
Next.js App Router  app/api/*  →  src/lib/api/handlers.ts
        │
        ├── RBAC / session     src/lib/auth/*
        ├── Mutations          src/lib/care-note/{entries,revision,concurrency}.ts
        ├── Reads              src/lib/care-note/{timeline,glance}.ts
        ├── PHI                src/lib/security/redact.ts
        ├── Learning           src/lib/learning/importance.ts
        └── Prisma             src/lib/db.ts  →  prisma/dev.db
```

Client **event bus** (`src/lib/events/bus.ts`) emits `entry:changed` after save so glance, timeline, and search refetch for that `patientId` only.

---

## 3. Data model (Prisma / SQLite)

| Model | Role |
| --- | --- |
| `Clinic`, `User` | Tenant + roles `PATIENT` \| `STAFF` \| `CLINICIAN` \| `ADMIN` |
| `CareEntry` | Current `body`, monotonic `version`, clinic + patient + author |
| `EntryRevision` | Immutable snapshot keyed by `(careEntryId, version)` |
| `Comment` | Internal thread on an entry |
| `Highlight` | Offsets, excerpt, optional `provenancePointer` |
| `HighlightFeedback` | Verdict `AGREE` \| `DISAGREE` \| `EDIT` \| `PIN` |
| `AuditLog` | Action + JSON metadata (no note text) |
| `FeatureWeight` | `featureKey` (e.g. `keyword:hyperpyrexia`) + `weight` |

---

## 4. HTTP API

Auth: `x-user-id` must match a `User.id`. `GET /api/demo` bootstraps the demo clinic (no actor required) and may seed one sample entry + risk highlight + internal comment.

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/demo` | Clinic, users, `patientId`, `defaultUserId` |
| GET | `/api/patients/[id]/timeline` | RBAC-filtered, PHI-redacted entries |
| GET | `/api/patients/[id]/glance` | Top card; `x-cache: HIT\|MISS` |
| POST | `/api/entries` | Create note; redaction + write RBAC |
| PATCH | `/api/entries/[id]` | `body` + `baseVersion`; snapshot / merge |
| POST | `/api/entries/[id]/revert` | Restore `targetVersion`; new version + audit |

---

## 5. Glance cache (warm path)

`src/lib/cache/glanceCache.ts` is a process-local `Map` keyed by `patientId`.

- **Fill** on first `getGlanceCard` miss (`computeGlanceCard`).
- **Invalidate** on Prisma `create`/`update`/`upsert` of `CareEntry`, `Comment`, or `Highlight` (`src/lib/db.ts` client extension).
- Card contents: highest-risk highlights (label/confidence + learned `importanceScore`), unresolved actions (TODO/plan-like text), recency score (exponential decay of last encounter).

---

## 6. Revisions, concurrency, provenance

- **`updateCareEntry`**: write current body to `EntryRevision` at current version, increment `CareEntry.version`, `AuditLog` `NOTE_EDIT`.
- **`revertCareEntry`**: snapshot current, restore target revision body, increment version, `NOTE_REVERT`.
- **`applyOptimisticEdit`**: if `baseVersion === version`, apply as a normal edit; if stale, 3-way **line merge** with clinician precedence and `pre-conflict-snapshot`.
- **Pointers**: `createProvenancePointer` / `resolveProvenancePointer`. Glance items link to `/timeline?entryId=&offset=&endOffset=` (and `pointer=`); timeline scrolls to `#entry-{id}` and `<mark>`s the span.

---

## 7. Self-learning importance

`recordHighlightFeedback({ highlightId, userId, verdict: PIN \| EDIT })` upserts `HighlightFeedback` and **increments** `FeatureWeight` for keywords extracted from the highlight excerpt. `importanceScore(text)` sums those weights. Subsequent identical extractions score higher (see `tests/test_self_learning_importance.test.ts`).

---

## 8. RBAC (server is source of truth)

| Role | Read | Write |
| --- | --- | --- |
| PATIENT | `PATIENT_FACING_SUMMARY` only; own patient + clinic | No clinical notes |
| STAFF | Clinical sections in clinic | Staff notes; cannot edit clinician notes |
| CLINICIAN | Clinical sections in clinic | Clinician notes; staff notes only with a version snapshot |
| ADMIN | Clinical sections in clinic | Privileged writes with snapshot rules on staff notes |

Clinic mismatch → `ForbiddenError` (HTTP 403). UI Role selector only remaps `x-user-id`; hiding comments/raw body is enforced in `getPatientTimeline`.

---

## 9. Test map (Vitest)

| File | Asserts |
| --- | --- |
| `tests/smoke.test.ts` | Runner + Prisma enums |
| `tests/test_rbac_scope.test.ts` | PHI redaction, clinic boundary, role write/read |
| `tests/test_revision_history.test.ts` | Version bump, revert, PHI-free audit metadata |
| `tests/test_highlight_provenance.test.ts` | Pointer → exact substring |
| `tests/test_concurrent_edits.test.ts` | No silent overwrite; clinician merge |
| `tests/test_ui_refresh.test.ts` | Event bus; glance/timeline refresh on save |
| `tests/test_self_learning_importance.test.ts` | PIN/EDIT raise weight and score |

```bash
npx vitest run
```

SQLite tests run with `fileParallelism: false`. UI refresh tests use jsdom.

---

## 10. PHI & operational notes

- Redact on **write** (`createCareEntry` / patch) and on **read** (timeline/glance excerpts).
- Audit metadata allowlist: `userId`, `entryId`, `newVersion`, optional `targetVersion`.
- In-memory glance cache is **per Node process** (not shared across instances).
- Demo auth is not production SSO; replace `x-user-id` with a real session before any live PHI.
