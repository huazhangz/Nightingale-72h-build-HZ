# Nightingale-72h-build-HZ: Single-Page Care Note & Longitudinal Timeline Engine

An enterprise-grade, high-performance Care Note Web Application engineered for acute clinical handovers and longitudinal patient tracking. Built with Next.js 14, TypeScript, Prisma, SQLite, and Tailwind CSS.

---

## 🚀 Setup & Run Instructions

### Prerequisites
- **Node.js**: v18.0.0 or higher
- **npm**: v9.0.0 or higher

### Installation & Launch

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Initialize the local SQLite database** (creates `prisma/dev.db` from `prisma/schema.prisma`):
   ```bash
   npx prisma db push
   npx prisma db seed
   ```

3. **Start the development server**:
   ```bash
   npm run dev
   ```

4. Open [http://localhost:3000](http://localhost:3000). The app redirects to `/timeline`. Use the header **Role** selector (`PATIENT`, `STAFF`, `CLINICIAN`) to switch the `x-user-id` actor and see RBAC-filtered data.

Demo clinic users are provisioned on first load via `GET /api/demo` (same identities as `prisma/seed.ts`).

### Environment

Copy `.env.example` to `.env` if needed:

```
DATABASE_URL="file:./dev.db"
```

Prisma CLI resolves this file relative to `prisma/`. The application client uses `prisma/dev.db` from the repo root.

### Tests

```bash
npm run test
# or
npx vitest run
```

---

## 🧭 Application surfaces

| Route | Purpose |
| --- | --- |
| `/timeline` | Longitudinal encounter list; provenance jump target (`?entryId=&offset=`) |
| `/glance` | P95 warm-path top card (risk highlights, unresolved actions, recency) |
| `/note-editor` | Create / patch care notes (revision snapshots + event bus refresh) |
| `/search` | Client-side filter over the same RBAC-filtered timeline |

Authentication for APIs is the `x-user-id` header (demo role switcher sets this).

---

## 🔐 Security & clinical safety (built-in)

- **PHI redaction** before storage / LLM-facing payloads (`src/lib/security/redact.ts`): names, Singapore NRIC/FIN, phones, emails → `[REDACTED]`.
- **Server-side RBAC** (`src/lib/auth/rbac.ts`): patients cannot read raw notes, internal comments, or AI-scribed sections; clinic-scoped isolation; staff cannot author clinician notes.
- **AuditLog** records `NOTE_EDIT` / `NOTE_REVERT` metadata (`userId`, `entryId`, `newVersion`) without note body/PHI.
- **Optimistic concurrency** with clinician-precedence merge and pre-conflict `EntryRevision` snapshots.

---

## 📚 More detail

See [TECHNICAL_BRIEF.md](./TECHNICAL_BRIEF.md) for architecture, data model, APIs, caching, provenance, and the test map.

Open-source licenses: [ATTRIBUTION.txt](./ATTRIBUTION.txt).
