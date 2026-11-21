import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Stateless signed session tokens (HMAC-SHA256), issued at login and carried in an HttpOnly cookie.
 * Replaces trust in a client-supplied `x-user-id` header, which any caller could forge.
 *
 * Format: base64url(JSON payload) "." base64url(HMAC(secret, payload part)).
 */

export const SESSION_COOKIE = "ng_session";
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

let devSecret: string | null = null;

function sessionSecret(): string {
  const configured = process.env.NIGHTINGALE_SESSION_SECRET;
  if (configured && configured.length >= 32) {
    return configured;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("NIGHTINGALE_SESSION_SECRET must be set (>= 32 chars) in production");
  }
  // Development / test: a per-process random secret. Sessions do not survive a restart, by design.
  devSecret ??= randomBytes(32).toString("hex");
  return devSecret;
}

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

export function sessionCookie(token: string, maxAgeSeconds = SESSION_TTL_SECONDS): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export function clearedSessionCookie(): string {
  return sessionCookie("", 0);
}

/**
 * Raw `x-user-id` header auth exists only for automated tests (vitest sets the flag). It is never
 * honoured in production, whatever the flag says.
 */
export function isHeaderAuthAllowed(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.NIGHTINGALE_ALLOW_HEADER_AUTH === "true";
}
