import type { Role } from "@prisma/client";
import { prisma } from "../db";
import {
  activateAccount,
  AuthError,
  authenticate,
  changePassword,
  createPatientRecord,
  inviteStaff,
  listClinicUsers,
  publicUser,
  registerPatient,
  reissueInvitation,
  issuePasswordReset,
  setUserStatus,
  signOutEverywhere,
} from "../auth/accounts";
import { assertSameOrigin, currentUser, errorResponse, HttpError, requireActor } from "../auth/session";
import { clearedSessionCookie, sessionCookie, signSession } from "../auth/session-token";
import { DEMO_PASSWORD } from "../auth/demo";
import { SlidingWindowLimiter } from "../agent/rate-limit";

/** HTTP layer for accounts. Every response that signs someone in sets a fresh signed session cookie. */

type Json = Record<string, unknown>;

async function body(request: Request): Promise<Json> {
  const parsed = (await request.json().catch(() => null)) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : {};
}

const str = (value: unknown) => (typeof value === "string" ? value : "");

function clientKey(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "local";
}

/**
 * Unauthenticated account endpoints cost a password hash per call and could be used to guess clinic
 * codes or probe which emails are registered, so they are limited per client address.
 */
const registerLimiter = new SlidingWindowLimiter(10, 60 * 60 * 1000);
const activateLimiter = new SlidingWindowLimiter(20, 10 * 60 * 1000);

function rateLimited(limiter: SlidingWindowLimiter, request: Request): Response | null {
  const result = limiter.take(clientKey(request));
  if (result.allowed) {
    return null;
  }
  return Response.json(
    { error: "Too many attempts. Try again later.", code: "RATE_LIMITED" },
    { status: 429, headers: { "retry-after": String(Math.ceil(result.retryAfterMs / 1000)) } },
  );
}

function withSession(payload: Json, user: { id: string; sessionVersion: number }, status = 200): Response {
  return Response.json(payload, { status, headers: { "set-cookie": sessionCookie(signSession(user.id, user.sessionVersion)) } });
}

function authErrorResponse(error: unknown): Response {
  if (error instanceof AuthError) {
    return Response.json({ error: error.message, code: error.code }, { status: 401 });
  }
  if (error instanceof HttpError && error.status === 429) {
    return Response.json({ error: error.message, code: error.code }, { status: 429, headers: { "retry-after": "600" } });
  }
  return errorResponse(error);
}

/** Origin for activation links: configured public URL, else the request's own origin. */
function appOrigin(request: Request): string {
  return process.env.NIGHTINGALE_PUBLIC_URL?.replace(/\/$/, "") || new URL(request.url).origin;
}

export async function handleLogin(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const payload = await body(request);
    const user = await authenticate({ email: str(payload.email), password: str(payload.password), clientKey: clientKey(request) });
    return withSession({ user: { id: user.id, role: user.role, name: user.name } }, user);
  } catch (error) {
    return authErrorResponse(error);
  }
}

export function handleLogout(): Response {
  return Response.json({ ok: true }, { headers: { "set-cookie": clearedSessionCookie() } });
}

export async function handleMe(request: Request): Promise<Response> {
  try {
    const user = await currentUser(request);
    if (!user) {
      return Response.json({ error: "Authentication required", code: "UNAUTHORIZED" }, { status: 401 });
    }
    const clinic = user.clinicId ? await prisma.clinic.findUnique({ where: { id: user.clinicId } }) : null;
    return Response.json({ user: publicUser({ ...user, clinic }), demoMode: process.env.NIGHTINGALE_DEMO_MODE === "true" });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleRegister(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const limited = rateLimited(registerLimiter, request);
    if (limited) return limited;
    const payload = await body(request);
    const user = await registerPatient({
      clinicCode: str(payload.clinicCode),
      name: str(payload.name),
      email: str(payload.email),
      password: str(payload.password),
      dateOfBirth: str(payload.dateOfBirth),
    });
    return withSession({ user: { id: user.id, role: user.role, name: user.name } }, user, 201);
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function handleActivate(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const limited = rateLimited(activateLimiter, request);
    if (limited) return limited;
    const payload = await body(request);
    const user = await activateAccount({ token: str(payload.token), password: str(payload.password) });
    return withSession({ user: { id: user.id, role: user.role, name: user.name } }, user);
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function handleChangePassword(request: Request): Promise<Response> {
  try {
    const actor = await requireActor(request);
    const payload = await body(request);
    const user = await changePassword(actor, { currentPassword: str(payload.currentPassword), newPassword: str(payload.newPassword) });
    return withSession({ ok: true }, user);
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function handleSignOutEverywhere(request: Request): Promise<Response> {
  try {
    const actor = await requireActor(request);
    await signOutEverywhere(actor);
    return Response.json({ ok: true }, { headers: { "set-cookie": clearedSessionCookie() } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleListUsers(request: Request): Promise<Response> {
  try {
    const actor = await requireActor(request);
    return Response.json({ users: await listClinicUsers(actor) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleInviteUser(request: Request): Promise<Response> {
  try {
    const actor = await requireActor(request);
    const payload = await body(request);
    const { user, token } = await inviteStaff(actor, {
      email: str(payload.email),
      name: str(payload.name),
      role: str(payload.role) as Role,
      title: str(payload.title),
      department: str(payload.department),
    });
    return Response.json(
      { user: { id: user.id, email: user.email, role: user.role, status: user.status }, activationUrl: `${appOrigin(request)}/activate?token=${token}` },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleUpdateUser(request: Request, userId: string): Promise<Response> {
  try {
    const actor = await requireActor(request);
    const payload = await body(request);
    const status = str(payload.status);
    if (status !== "ACTIVE" && status !== "DISABLED") {
      throw new HttpError(400, "INVALID_STATUS", "status must be ACTIVE or DISABLED");
    }
    await setUserStatus(actor, userId, status);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleReissueInvitation(request: Request, userId: string): Promise<Response> {
  try {
    const actor = await requireActor(request);
    const token = await reissueInvitation(actor, userId);
    return Response.json({ activationUrl: `${appOrigin(request)}/activate?token=${token}` });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handlePasswordReset(request: Request, userId: string): Promise<Response> {
  try {
    const actor = await requireActor(request);
    const token = await issuePasswordReset(actor, userId);
    return Response.json({ resetUrl: `${appOrigin(request)}/activate?token=${token}` });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleCreatePatient(request: Request): Promise<Response> {
  try {
    const actor = await requireActor(request);
    const payload = await body(request);
    const { user, token } = await createPatientRecord(actor, {
      name: str(payload.name),
      dateOfBirth: str(payload.dateOfBirth),
      email: str(payload.email),
      phone: str(payload.phone),
    });
    return Response.json(
      { patient: { id: user.id, name: user.name, status: user.status }, activationUrl: token ? `${appOrigin(request)}/activate?token=${token}` : null },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}


/** Demo sign-in shortcuts. Served only when NIGHTINGALE_DEMO_MODE=true (never enable in production). */
export async function handleDemoAccounts(): Promise<Response> {
  if (process.env.NIGHTINGALE_DEMO_MODE !== "true") {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const users = await prisma.user.findMany({
    where: { email: { in: ["clinician@nightingale.test", "staff@nightingale.test", "admin@nightingale.test", "elena.rossi@nightingale.test"] }, status: "ACTIVE" },
    select: { email: true, name: true, role: true },
  });
  const order = ["CLINICIAN", "STAFF", "ADMIN", "PATIENT"];
  return Response.json({
    accounts: users
      .sort((left, right) => order.indexOf(left.role) - order.indexOf(right.role))
      .map((user) => ({ ...user, password: DEMO_PASSWORD })),
  });
}
