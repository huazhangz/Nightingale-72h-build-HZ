# Changelog

## v1.0.0 — 2026-11-23

First production-grade delivery of Nightingale: a longitudinal care-note platform with two clinical agents, measured on frozen and challenge evaluation sets. Synthetic data only; not certified for real patient data (see [docs/SECURITY.md](./docs/SECURITY.md) §9).

### Agents

- **Risk triage agent:** a level (LOW–CRITICAL), a review window and cited drivers for every patient, re-assessed after each note. The final level is `max(model, deterministic floor)`. Clinician overrides need a reason, are audited, survive reassessment and can be cleared. On Gemini 2.5 Flash with `risk-v2`: 96.4% exact over 84 core trials, 90.9% on 33 challenge cases, and no under-triage on any of the 61 cases.
- **Handover agent:** a summary in which every line quotes its source note, verified by the server. The critical-finding floor is never lowered. Follow-ups are proposals that a clinician accepts. Citation repair round: +15.8 points on core cases (p = 0.016).
- **New in this release, `handover-v6` (default):**
  - an explicit follow-up procedure;
  - a one-time submit check that asks about documented pending actions with no follow-up.
  - Validated offline on 479 recorded live runs: it would have asked in 5 of the 6 real misses and in 0 of the 107 runs where a follow-up is a misuse.
  - A live re-run is pending budget. `NIGHTINGALE_AGENT_PROMPT=handover-v4` restores the previous default.
- **One platform** for both agents (Anthropic SDK Tool Runner): strict tools, budgets, retries, an outcome taxonomy and per-run traces with no PHI. Providers: Anthropic, Gemini (native or OpenAI-compatible), and an offline simulated mode.

### Evaluation

- 50 handover cases and 61 risk cases. The frozen core sets are hash-pinned in the tests; challenge sets are reported separately.
- Statistics: pass@k / pass^k, case-clustered bootstrap intervals, paired permutation tests, triage metrics (under-triage, quadratic weighted kappa).
- Harness self-tests in CI (oracle / null / rule baselines), a live spend cap, regrading and a blind label-review workflow.
- New: `npm run eval:replay-followups` (check replay over saved transcripts), plus `skip-followups-v4/-v6`, `rules-v6`, `oracle-v6` and `gemini-v6` presets.

### Accounts and security

- **Passwords and sessions:** scrypt passwords, lockout and rate limits; signed sessions with server-side revocation.
- **Accounts:** staff join by invitation, patients enrol with a clinic code, admins issue password-reset links.
- **Access control:** RBAC and clinic scope on every API route; same-origin checks; CSP and security headers; PHI redaction on write, read and agent output.
- **Fixed in this release: random bounces to the login page.**
  - The session cookie is now named after the server's signing secret (`ng_session_<fingerprint>`). Two Nightingale servers on one host (dev server, Docker, a second clone) used to overwrite each other's `ng_session` cookie, because cookies are not separated by port.
  - A 401 is now confirmed with `/api/auth/me` before signing the user out, and a transient one is retried once.
  - A confirmed sign-out shows "Your session has ended" instead of flashing "Authentication required".
  - The development secret file is created exclusively, so concurrent first requests agree on one secret.
  - In development, the server logs why a session was rejected.

### Operations

- Startup configuration checks: the server refuses to start in production without a session secret, or with demo mode on.
- `/api/health`, a Docker image with a healthcheck, `docker-compose.yml`, online SQLite backups (`npm run db:backup`), and `npm run admin:create`.
- See [docs/DEPLOYMENT.zh.md](./docs/DEPLOYMENT.zh.md) for the go-live checklist.

### Known limits

- Single instance: SQLite and in-process rate limits.
- No email delivery, SSO or MFA.
- CSP allows inline scripts.
- Ground-truth labels are author-written; a clinical blind review is prepared but not done ([docs/LABEL_REVIEW.zh.md](./docs/LABEL_REVIEW.zh.md)).
- Claude has not been evaluated live (needs an Anthropic key).
- `handover-v6` has offline evidence only.
