import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Stateless signed session tokens (HMAC-SHA256), issued at login and carried in an HttpOnly cookie.
 * Replaces trust in a client-supplied `x-user-id` header, which any caller could forge.
 *
 * Format: base64url(JSON payload) "." base64url(HMAC(secret, payload part)).
 */

/** Prefix of the session cookie name. The full name adds a fingerprint of the signing secret. */
export const SESSION_COOKIE_PREFIX = "ng_session";
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

export type SessionPayload = {
  /** User id. */
  sub: string;
  /** User.sessionVersion at issue time; a bump revokes every older session. */
  sv: number;
  /** Issued-at and expiry, seconds since epoch. */
  iat: number;
  exp: number;
};

export const DEV_SECRET_FILE = ".nightingale-dev-secret";

/**
 * Development / test secret, used when NIGHTINGALE_SESSION_SECRET is not set (never in production).
 * It must be one value for the whole server: `next dev` compiles each route separately, so a
 * module-level random value differed between /api/auth/login and /api/auth/me and every session was
 * rejected (the app bounced back to /login). The secret is therefore kept on globalThis and in a
 * git-ignored file in the working directory, so all routes and restarts share it. If the file
 * cannot be written, a process-wide random value is used.
 */
function developmentSecret(): string {
  const holder = globalThis as unknown as { nightingaleDevSecret?: string };
  if (holder.nightingaleDevSecret) {
    return holder.nightingaleDevSecret;
  }
  const file = path.resolve(process.cwd(), DEV_SECRET_FILE);
  let secret: string | null = null;
  try {
    const stored = readFileSync(file, "utf8").trim();
    secret = stored.length >= 32 ? stored : null;
  } catch {
    secret = null;
  }
  if (!secret) {
    const generated = randomBytes(32).toString("hex");
    try {
      // Exclusive create: if another process created the file first, its value wins and is read back.
      writeFileSync(file, `${generated}\n`, { mode: 0o600, flag: "wx" });
      secret = generated;
    } catch {
      try {
        const stored = readFileSync(file, "utf8").trim();
        secret = stored.length >= 32 ? stored : generated;
      } catch {
        // Read-only working directory: the process-wide value still keeps routes consistent.
        secret = generated;
      }
    }
  }
  holder.nightingaleDevSecret = secret;
  return secret;
}

function sessionSecret(): string {
  const configured = process.env.NIGHTINGALE_SESSION_SECRET;
  if (configured && configured.length >= 32) {
    return configured;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("NIGHTINGALE_SESSION_SECRET must be set (>= 32 chars) in production");
  }
  return developmentSecret();
}

/**
 * Session cookie name: `ng_session_<8 hex of SHA-256(secret)>`. Browsers do not separate cookies by
 * port, so two Nightingale servers on one host (a dev server and a Docker container, or two clones
 * with different secrets) used to overwrite each other's `ng_session` cookie: signing in on one
 * signed you out of the other, which looked like a random bounce to the login page. With a
 * per-secret name each server only reads its own cookie. The fingerprint does not reveal the secret.
 */
export function sessionCookieName(): string {
  const fingerprint = createHash("sha256").update(`nightingale-cookie:${sessionSecret()}`).digest("hex").slice(0, 8);
  return `${SESSION_COOKIE_PREFIX}_${fingerprint}`;
}

/** Session-looking cookie names in a Cookie header (this server's or another's on the same host). */
export function sessionCookieNames(header: string | null): string[] {
  if (!header) {
    return [];
  }
  return header
    .split(";")
    .map((part) => part.trim().split("=")[0] ?? "")
    .filter((name) => name === SESSION_COOKIE_PREFIX || name.startsWith(`${SESSION_COOKIE_PREFIX}_`));
}

/**
 * The pre-fingerprint cookie name. Sign-in and sign-out expire it; cookies of other servers on the
 * same host are left alone, so signing in here never signs you out there.
 */
export const LEGACY_SESSION_COOKIE = SESSION_COOKIE_PREFIX;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(part: string, secret: string): string {
  return base64url(createHmac("sha256", secret).update(part).digest());
}

export function signSession(
  userId: string,
  sessionVersion = 0,
  now: Date = new Date(),
  ttlSeconds = SESSION_TTL_SECONDS,
): string {
  const iat = Math.floor(now.getTime() / 1000);
  const payload: SessionPayload = { sub: userId, sv: sessionVersion, iat, exp: iat + ttlSeconds };
  const part = base64url(JSON.stringify(payload));
  return `${part}.${sign(part, sessionSecret())}`;
}

/** Returns the payload when the signature is valid and the token has not expired, else null. */
export function verifySession(token: string | null | undefined, now: Date = new Date()): SessionPayload | null {
  if (!token) {
    return null;
  }
  const [part, signature, extra] = token.split(".");
  if (!part || !signature || extra !== undefined) {
    return null;
  }
  const expected = Buffer.from(sign(part, sessionSecret()));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof (payload as SessionPayload).sub !== "string" ||
    typeof (payload as SessionPayload).sv !== "number" ||
    typeof (payload as SessionPayload).exp !== "number"
  ) {
    return null;
  }
  const session = payload as SessionPayload;
  if (session.exp <= Math.floor(now.getTime() / 1000)) {
    return null;
  }
  return session;
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) {
    return null;
  }
  for (const part of header.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (rawKey === name) {
      return decodeURIComponent(rest.join("="));
    }
  }
  return null;
}

export function sessionCookie(token: string, maxAgeSeconds = SESSION_TTL_SECONDS, name = sessionCookieName()): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export function clearedSessionCookie(name = sessionCookieName()): string {
  return sessionCookie("", 0, name);
}

/** The session token this server issued, read from a Cookie header. */
export function readSessionCookie(header: string | null): string | null {
  return readCookie(header, sessionCookieName());
}

/**
 * Raw `x-user-id` header auth exists only for automated tests (vitest sets the flag). It is never
 * honoured in production, whatever the flag says.
 */
export function isHeaderAuthAllowed(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.NIGHTINGALE_ALLOW_HEADER_AUTH === "true";
}
