# Security

**Scope:** authentication, sessions, account lifecycle, authorization, browser protections, PHI handling and the agents' security boundary. Agent internals are in [AGENT_DESIGN.md](./AGENT_DESIGN.md); the review that motivated these controls is in [UPGRADE_PLAN.zh.md](./UPGRADE_PLAN.zh.md) §1.

This is a demonstration system with synthetic data. The controls below are built to production patterns, and the remaining gaps are listed in §9. It is not certified for real patient data.

---

## 1. Accounts and roles

| Role | Who | Can |
| --- | --- | --- |
| `PATIENT` | Self-registered with a clinic code, or created by staff | Read their own released notes, glance and timeline |
| `STAFF` | Nurses, invited by an admin | Clinical read/write within RBAC rules, worklist, risk levels, handover summaries |
| `CLINICIAN` | Doctors, invited by an admin | As staff, plus risk overrides and clinician-only content |
| `ADMIN` | Clinic administrators, invited by an admin | User administration; clinical read access |

Every non-patient account is created by **invitation**; nobody can self-register as staff. Patients either register themselves with the clinic's enrollment code or are created by clinical staff (with or without portal access).

Service accounts (the risk triage agent, one per clinic) have `isServiceAccount = true`, status `DISABLED` and an unusable password hash: they can never sign in, and session checks reject them even with a valid token.

## 2. Authentication

- **Passwords:** scrypt (N = 2^15, r = 8, p = 1, 64-byte key, per-user salt), compared in constant time. Policy: 10–128 characters, at least one letter and one digit, not containing the email's local part (when 4+ characters), not on a common-password list. Verification of an unknown email still runs a dummy hash, so response time does not reveal which emails exist.
- **One error message** for every sign-in failure (unknown email, wrong password, locked, invited, disabled): "Incorrect email or password."
- **Lockout:** 5 consecutive failures lock the account for 15 minutes. Success resets the counter.
- **Rate limits** (sliding window, per client address and per email): sign-in 30 per address and 10 per email per 10 minutes; registration 10 per address per hour; activation 20 per address per 10 minutes; risk reassessment 10 per user per 10 minutes; handover runs 6 per user per 10 minutes (configurable).
- **Audit:** `LOGIN_SUCCESS`, `LOGIN_FAILURE` (for existing accounts; never the password), `ACCOUNT_ACTIVATED`, `PASSWORD_CHANGED`, `SESSIONS_REVOKED`, `USER_INVITED`, `USER_ENABLED`, `USER_DISABLED`, `INVITATION_REISSUED`, `PATIENT_SELF_REGISTERED`, `PATIENT_CREATED`, `RISK_OVERRIDE`.

## 3. Sessions

- Stateless token `{sub, sv, iat, exp}` signed with HMAC-SHA256 (`NIGHTINGALE_SESSION_SECRET`, at least 32 characters, **required in production**: the server refuses to start without it. In development a random secret is generated once and kept in the git-ignored file `.nightingale-dev-secret`, so every route (and every restart) shares it).
- Cookie `ng_session`: `HttpOnly; SameSite=Lax; Path=/; Max-Age=8h`, plus `Secure` in production.
- **Revocation:** every user has a `sessionVersion`, carried in the token as `sv`. Changing the password, *Sign out of all devices* and an admin disabling the account all bump it, which invalidates every outstanding token at once. Each request re-checks the version and that the account is `ACTIVE` and not a service account.
- Changing the password re-issues a session for the current device.
- **Header authentication** (`x-user-id`, used by tests) is accepted only when `NODE_ENV !== "production"` **and** `NIGHTINGALE_ALLOW_HEADER_AUTH=true`. It is off by default everywhere and impossible in production.

## 4. Account lifecycle

```
Admin invites (email, name, role)   ──▶  User INVITED + Invitation {SHA-256(token), expires 72 h}
                                          │ activation link shown once to the admin
Invitee opens /activate?token=…     ──▶  sets password (policy) ──▶ ACTIVE, signed in; token used
Admin: new link (old ones invalid) · disable (sessions revoked) · enable
Patient: /register with clinic code ──▶  ACTIVE PATIENT, signed in
Staff: Add patient (no email)       ──▶  record only, no portal login
```

Only the hash of an activation token is stored; tokens are 32 random bytes, single-use and expire after 72 hours. Re-issuing a link invalidates earlier ones. Links use `NIGHTINGALE_PUBLIC_URL` when set (recommended behind a proxy), otherwise the request's origin. There is no email delivery yet: the admin copies the link to the invitee through a trusted channel.

## 5. Authorization

- **Clinic scope** on every resource (`assertClinicScope`) and **patient isolation** for patients (`assertPatientIsolation`).
- **Section rules:** patients see released, patient-visible content only; nurses do not see unreleased clinician drafts; AI-scribed clinician content and internal comments are role-gated (`src/lib/auth/rbac.ts`, unit-tested).
- **Write rules:** nurses and clinicians write their own note types; risk overrides are clinician/admin only; user administration is admin only and never on one's own account.
- **API:** every route resolves the actor through `requireActor` (session, same-origin check, account status) before any data access.
- **Pages:** `middleware.ts` redirects page requests without a session cookie to `/login?next=…`; the app shell then verifies the session through `/api/auth/me`. The redirect target after sign-in accepts same-site relative paths only (`safeNext`, open-redirect safe).

## 6. Browser protections

- **CSRF:** cookies are `SameSite=Lax`, and every state-changing request must carry an `Origin` (or `Referer`) whose host matches the request's host (`x-forwarded-host` / `host`). A literal `Origin: null` is refused. Requests with neither header (non-browser clients) are allowed, since they cannot carry a victim's cookie.
- **Headers** on every response: Content-Security-Policy (`default-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`, `form-action 'self'`, `connect-src 'self'`; inline scripts and styles allowed because the App Router inlines bootstrap data), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera, microphone, geolocation off), `Cross-Origin-Opener-Policy: same-origin`, HSTS in production. `X-Powered-By` is removed. All `/api` responses are `Cache-Control: no-store`.
- The UI never stores tokens or PHI in `localStorage`; it remembers only the selected patient id and language.

## 7. PHI

- Note bodies, titles, comments and highlight excerpts are redacted on write and on read (`redactPhi`: emails; Singapore, Finnish, German and French phone formats; Singapore NRIC/FIN and PRC resident IDs; names next to honorifics or name labels, in English and Chinese).
- The worklist shows names, risk levels and counts, never contact details. The removed `/api/demo` endpoint used to return every patient's name and phone number without authentication.
- Agents receive redacted text and no patient names. Their output is re-redacted. Their persisted trace holds sizes, timings and error codes, never payloads. See AGENT_DESIGN.md §1.

## 8. Agents

- Tools are bound to one actor and one patient at the start of a run; no tool takes a patient id, so injected text cannot redirect a run.
- The handover agent acts with the requesting user's permissions. The risk agent uses a non-login service account, and its evidence is filtered again for each viewer.
- Model output cannot write to the record: follow-ups are proposals a clinician accepts, and risk levels can only be raised by the floor or changed by a clinician with a reason.
- `NIGHTINGALE_AGENTS_ENABLED=false` is a kill switch for every model call.
- The risk drain endpoint requires `x-cron-secret` (compared in constant time, at least 16 characters) and returns 404 when no secret is configured.
- Demo sign-in shortcuts (`/api/auth/demo-accounts`) exist only when `NIGHTINGALE_DEMO_MODE=true`, and must never be enabled in production.

## 9. Known gaps

| Gap | Impact | Mitigation / next step |
| --- | --- | --- |
| Rate limiters are in-process | Limits are per instance and reset on restart | Move to a shared store (Redis) for multi-instance deployments |
| Client address comes from `X-Forwarded-For` | Without a proxy that overwrites the header, a client can rotate it to evade per-address limits | Deploy behind a proxy that sets it; per-email limits and account lockout still apply |
| Registration reveals whether an email is registered (`EMAIL_TAKEN`) | Email enumeration, limited to 10 attempts per address per hour | Email verification flow once email delivery exists |
| No email delivery | Admins hand activation links over manually | Integrate a mail provider; links are already single-use and hashed |
| No MFA or SSO | Password-only sign-in | OIDC/SAML for staff; TOTP or WebAuthn as a second factor |
| No self-service password reset | An administrator issues a one-time reset link (clinical staff for patients); it expires after 72 h and signs out old sessions when used | Self-service reset over email once email delivery exists |
| CSP allows inline scripts | Weaker XSS containment | Nonce-based CSP via middleware |
| SQLite | No encryption at rest, single writer | PostgreSQL with encrypted storage and backups |
