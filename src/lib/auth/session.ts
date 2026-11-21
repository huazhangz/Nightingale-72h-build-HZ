import { prisma } from "../db";
import { ForbiddenError, type Actor } from "./rbac";
import { ConflictError } from "./conflict";
import { SESSION_COOKIE, isHeaderAuthAllowed, readCookie, verifySession } from "./session-token";

export class UnauthorizedError extends Error {
  readonly code = "UNAUTHORIZED" as const;

  constructor(message = "Authentication required") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

/**
 * Resolve the calling user.
 *
 * 1. A signed session (cookie or `Authorization: Bearer`) always wins.
 * 2. The raw `x-user-id` header is honoured only when header auth is allowed (demo/dev/tests).
 *
 * Role and clinic are re-read from the database on every request, so a role change or clinic
 * reassignment takes effect immediately rather than when the token expires.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence in depth (cookies are already SameSite=Lax): a state-changing request that carries an
 * Origin (or Referer) must come from this host. Requests without either header come from non-browser
 * clients, which cannot ride a user's cookie, and are allowed.
 */
export function assertSameOrigin(request: Request): void {
  if (SAFE_METHODS.has(request.method.toUpperCase())) {
    return;
  }
  const source = request.headers.get("origin") ?? request.headers.get("referer");
  if (!source || source === "null") {
    if (source === "null") {
      throw new ForbiddenError("Cross-site request blocked");
    }
    return;
  }
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host;
  let sourceHost: string;
  try {
    sourceHost = new URL(source).host;
  } catch {
    throw new ForbiddenError("Cross-site request blocked");
  }
  if (sourceHost !== host) {
    throw new ForbiddenError("Cross-site request blocked");
  }
}

/** The signed-in user behind a request, or null. Session version and account status are re-checked. */
export async function currentUser(request: Request) {
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE) ?? bearerToken(request);
  const session = verifySession(token);
  let user = session ? await prisma.user.findUnique({ where: { id: session.sub } }) : null;
  if (user && session && user.sessionVersion !== session.sv) {
    user = null;
  }
  if (!user && !session && isHeaderAuthAllowed()) {
    const headerId = request.headers.get("x-user-id");
    user = headerId ? await prisma.user.findUnique({ where: { id: headerId } }) : null;
  }
  if (!user || user.isServiceAccount || user.status !== "ACTIVE") {
    return null;
  }
  return user;
}

/**
 * Resolve the calling user from a signed session (cookie or Bearer). Role, clinic, status and session
 * version are re-read from the database on every request, so a role change, a disabled account or a
 * "sign out everywhere" takes effect immediately. State-changing requests must be same-origin.
 */
export async function requireActor(request: Request): Promise<Actor> {
  assertSameOrigin(request);
  const user = await currentUser(request);
  if (!user) {
    throw new UnauthorizedError();
  }
  return { id: user.id, role: user.role, clinicId: user.clinicId };
}

export function errorResponse(error: unknown): Response {
  if (error instanceof UnauthorizedError) {
    return Response.json({ error: error.message, code: error.code }, { status: 401 });
  }
  if (error instanceof ForbiddenError) {
    return Response.json({ error: error.message, code: error.code }, { status: 403 });
  }
  if (error instanceof ConflictError) {
    return Response.json(
      {
        error: error.message,
        code: error.code,
        currentVersion: error.currentVersion,
        currentBody: error.currentBody,
        currentTitle: error.currentTitle,
      },
      { status: 409 },
    );
  }
  if (isNotFound(error)) {
    return Response.json({ error: "Not found", code: "NOT_FOUND" }, { status: 404 });
  }
  if (error instanceof HttpError) {
    return Response.json({ error: error.message, code: error.code }, { status: error.status });
  }
  // Never echo internal error text (SQL, stack details, PHI fragments) to the client in production.
  const errorId = crypto.randomUUID();
  console.error(`[nightingale] unhandled error ${errorId}`, error);
  const message =
    process.env.NODE_ENV === "production"
      ? "Internal error"
      : error instanceof Error
        ? error.message
        : "Internal error";
  return Response.json({ error: message, code: "INTERNAL", errorId }, { status: 500 });
}

/** Typed HTTP error for handler code paths that need a specific status (400, 429, 503, …). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function isNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "P2025" || /No .* found/.test(error.message);
}
