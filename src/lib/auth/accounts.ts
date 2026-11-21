import { createHash, randomBytes } from "node:crypto";
import type { Role, User } from "@prisma/client";
import { prisma } from "../db";
import { SlidingWindowLimiter } from "../agent/rate-limit";
import { hashPassword, passwordIssues, verifyPassword } from "./password";
import { ForbiddenError, type Actor } from "./rbac";
import { HttpError } from "./session";

/**
 * Account lifecycle: sign-in with lockout, patient self-registration, invitations and activation,
 * password changes, session revocation and admin user management.
 */

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;
export const INVITATION_TTL_MS = 72 * 60 * 60 * 1000;
const GENERIC_LOGIN_ERROR = "Email or password is incorrect, or the account is temporarily locked.";

const ipLimiter = new SlidingWindowLimiter(30, 10 * 60 * 1000);
const emailLimiter = new SlidingWindowLimiter(10, 10 * 60 * 1000);

export class AuthError extends Error {
  readonly code = "INVALID_CREDENTIALS" as const;
  constructor() {
    super(GENERIC_LOGIN_ERROR);
    this.name = "AuthError";
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isEmail(value: string): boolean {
  return /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(value);
}

function assertPassword(password: string, email: string): void {
  const issues = passwordIssues(password, { email });
  if (issues.length > 0) {
    throw new HttpError(400, "WEAK_PASSWORD", `Password does not meet the policy: ${issues.join(", ")}`);
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function audit(action: string, actorId: string | null, entityId: string): Promise<void> {
  await prisma.auditLog.create({
    data: { actorId, action, entityType: "User", entityId, metadata: actorId ? { userId: actorId } : {} },
  });
}

/** Rate limits per client address and per email; then constant-shape verification and lockout. */
export async function authenticate(input: { email: string; password: string; clientKey: string }): Promise<User> {
  const email = normalizeEmail(input.email);
  if (!ipLimiter.take(input.clientKey).allowed || !emailLimiter.take(email).allowed) {
    throw new HttpError(429, "RATE_LIMITED", "Too many sign-in attempts. Try again in a few minutes.");
  }
  const user = await prisma.user.findUnique({ where: { email } });
  const passwordOk = await verifyPassword(input.password, user?.passwordHash);
  const now = new Date();
  if (!user) {
    throw new AuthError();
  }
  const locked = user.lockedUntil !== null && user.lockedUntil > now;
  if (!passwordOk || locked || user.status !== "ACTIVE" || user.isServiceAccount) {
    if (!passwordOk && !locked) {
      const failed = user.failedLoginCount + 1;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: failed >= MAX_FAILED_LOGINS ? 0 : failed,
          ...(failed >= MAX_FAILED_LOGINS ? { lockedUntil: new Date(now.getTime() + LOCKOUT_MS) } : {}),
        },
      });
    }
    await audit("LOGIN_FAILURE", null, user.id);
    throw new AuthError();
  }
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now },
  });
  await audit("LOGIN_SUCCESS", user.id, user.id);
  return updated;
}

/** Patient self-registration with a clinic's enrollment code. */
export async function registerPatient(input: {
  clinicCode: string;
  name: string;
  email: string;
  password: string;
  dateOfBirth: string;
}): Promise<User> {
  const email = normalizeEmail(input.email);
  const name = input.name.trim().replace(/\s+/g, " ");
  if (!isEmail(email)) throw new HttpError(400, "INVALID_EMAIL", "Enter a valid email address");
  if (name.length < 2 || name.length > 120) throw new HttpError(400, "INVALID_NAME", "Enter your full name");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dateOfBirth) || Number.isNaN(Date.parse(input.dateOfBirth))) {
    throw new HttpError(400, "INVALID_DOB", "Enter your date of birth as YYYY-MM-DD");
  }
  assertPassword(input.password, email);
  const clinic = await prisma.clinic.findFirst({ where: { enrollmentCode: input.clinicCode.trim() } });
  if (!clinic || !input.clinicCode.trim()) {
    throw new HttpError(400, "INVALID_CLINIC_CODE", "The clinic code is not valid");
  }
  if (await prisma.user.findUnique({ where: { email } })) {
    throw new HttpError(409, "EMAIL_TAKEN", "An account with this email already exists");
  }
  const user = await prisma.user.create({
    data: {
      email,
      name,
      role: "PATIENT",
      clinicId: clinic.id,
      dateOfBirth: input.dateOfBirth,
      passwordHash: await hashPassword(input.password),
      passwordChangedAt: new Date(),
      status: "ACTIVE",
    },
  });
  await audit("PATIENT_SELF_REGISTERED", user.id, user.id);
  return user;
}

async function issueInvitation(userId: string, createdById: string | null): Promise<string> {
  await prisma.invitation.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } });
  const token = randomBytes(32).toString("base64url");
  await prisma.invitation.create({
    data: { userId, tokenHash: tokenHash(token), createdById, expiresAt: new Date(Date.now() + INVITATION_TTL_MS) },
  });
  return token;
}

function assertAdmin(actor: Actor): void {
  if (actor.role !== "ADMIN") throw new ForbiddenError("Administrator access required");
}

function assertClinical(actor: Actor): void {
  if (actor.role !== "STAFF" && actor.role !== "CLINICIAN" && actor.role !== "ADMIN") {
    throw new ForbiddenError("Clinical staff access required");
  }
}

/** Admin invites a staff member, clinician or admin. Returns the one-time activation token. */
export async function inviteStaff(
  actor: Actor,
  input: { email: string; name: string; role: Role; title?: string; department?: string },
): Promise<{ user: User; token: string }> {
  assertAdmin(actor);
  if (input.role !== "STAFF" && input.role !== "CLINICIAN" && input.role !== "ADMIN") {
    throw new HttpError(400, "INVALID_ROLE", "Invite STAFF, CLINICIAN or ADMIN; patients are registered separately");
  }
  const email = normalizeEmail(input.email);
  if (!isEmail(email)) throw new HttpError(400, "INVALID_EMAIL", "Enter a valid email address");
  if (await prisma.user.findUnique({ where: { email } })) {
    throw new HttpError(409, "EMAIL_TAKEN", "An account with this email already exists");
  }
  const user = await prisma.user.create({
    data: {
      email,
      name: input.name.trim(),
      role: input.role,
      clinicId: actor.clinicId,
      title: input.title?.trim() || null,
      department: input.department?.trim() || null,
      passwordHash: "!invited",
      status: "INVITED",
    },
  });
  const token = await issueInvitation(user.id, actor.id);
  await audit("USER_INVITED", actor.id, user.id);
  return { user, token };
}

/** Staff register a patient record; with an email it gets a portal invitation. */
export async function createPatientRecord(
  actor: Actor,
  input: { name: string; dateOfBirth: string; email?: string; phone?: string },
): Promise<{ user: User; token: string | null }> {
  assertClinical(actor);
  const name = input.name.trim().replace(/\s+/g, " ");
  if (name.length < 2) throw new HttpError(400, "INVALID_NAME", "Enter the patient's full name");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dateOfBirth)) throw new HttpError(400, "INVALID_DOB", "Date of birth must be YYYY-MM-DD");
  const email = input.email?.trim() ? normalizeEmail(input.email) : null;
  if (email && !isEmail(email)) throw new HttpError(400, "INVALID_EMAIL", "Enter a valid email address");
  if (email && (await prisma.user.findUnique({ where: { email } }))) {
    throw new HttpError(409, "EMAIL_TAKEN", "An account with this email already exists");
  }
  const user = await prisma.user.create({
    data: {
      email: email ?? `patient+${randomBytes(9).toString("hex")}@no-portal.nightingale.internal`,
      name,
      role: "PATIENT",
      clinicId: actor.clinicId,
      dateOfBirth: input.dateOfBirth,
      phone: input.phone?.replace(/[^\d+]/g, "") || null,
      passwordHash: "!no-portal-access",
      status: email ? "INVITED" : "ACTIVE",
    },
  });
  const token = email ? await issueInvitation(user.id, actor.id) : null;
  await audit("PATIENT_CREATED", actor.id, user.id);
  return { user, token };
}

export async function activateAccount(input: { token: string; password: string }): Promise<User> {
  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash: tokenHash(input.token) },
    include: { user: true },
  });
  if (!invitation || invitation.usedAt || invitation.expiresAt < new Date() || invitation.user.status === "DISABLED") {
    throw new HttpError(400, "INVALID_INVITATION", "This activation link is invalid or has expired");
  }
  assertPassword(input.password, invitation.user.email);
  const [user] = await prisma.$transaction([
    prisma.user.update({
      where: { id: invitation.userId },
      data: {
        passwordHash: await hashPassword(input.password),
        passwordChangedAt: new Date(),
        status: "ACTIVE",
        sessionVersion: { increment: 1 },
        failedLoginCount: 0,
        lockedUntil: null,
      },
    }),
    prisma.invitation.update({ where: { id: invitation.id }, data: { usedAt: new Date() } }),
  ]);
  await audit("ACCOUNT_ACTIVATED", user.id, user.id);
  return user;
}

/** Changing the password signs out every other session (the caller re-issues its own cookie). */
export async function changePassword(actor: Actor, input: { currentPassword: string; newPassword: string }): Promise<User> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
    throw new HttpError(400, "WRONG_PASSWORD", "The current password is incorrect");
  }
  if (input.currentPassword === input.newPassword) {
    throw new HttpError(400, "SAME_PASSWORD", "Choose a different password");
  }
  assertPassword(input.newPassword, user.email);
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(input.newPassword), passwordChangedAt: new Date(), sessionVersion: { increment: 1 } },
  });
  await audit("PASSWORD_CHANGED", user.id, user.id);
  return updated;
}

export async function signOutEverywhere(actor: Actor): Promise<void> {
  await prisma.user.update({ where: { id: actor.id }, data: { sessionVersion: { increment: 1 } } });
  await audit("SESSIONS_REVOKED", actor.id, actor.id);
}

export type AdminUserView = {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: User["status"];
  title: string | null;
  department: string | null;
  lastLoginAt: string | null;
  locked: boolean;
};

export async function listClinicUsers(actor: Actor): Promise<AdminUserView[]> {
  assertAdmin(actor);
  const users = await prisma.user.findMany({
    where: { clinicId: actor.clinicId, isServiceAccount: false, role: { not: "PATIENT" } },
    orderBy: [{ role: "asc" }, { name: "asc" }],
  });
  return users.map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    title: user.title,
    department: user.department,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    locked: user.lockedUntil !== null && user.lockedUntil > new Date(),
  }));
}

export async function setUserStatus(actor: Actor, userId: string, status: "ACTIVE" | "DISABLED"): Promise<void> {
  assertAdmin(actor);
  if (userId === actor.id) {
    throw new HttpError(400, "SELF_STATUS", "You cannot change your own account status");
  }
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.clinicId !== actor.clinicId || user.isServiceAccount) {
    throw new ForbiddenError("User is outside your clinic");
  }
  if (status === "ACTIVE" && user.status === "INVITED") {
    throw new HttpError(400, "NOT_ACTIVATED", "Invited users activate their own account");
  }
  await prisma.user.update({
    where: { id: userId },
    data: { status, sessionVersion: { increment: 1 }, ...(status === "ACTIVE" ? { failedLoginCount: 0, lockedUntil: null } : {}) },
  });
  await audit(status === "DISABLED" ? "USER_DISABLED" : "USER_ENABLED", actor.id, userId);
}

export async function reissueInvitation(actor: Actor, userId: string): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.role === "PATIENT") assertClinical(actor);
  else assertAdmin(actor);
  if (user.clinicId !== actor.clinicId || user.isServiceAccount) {
    throw new ForbiddenError("User is outside your clinic");
  }
  if (user.status !== "INVITED") {
    throw new HttpError(400, "NOT_INVITED", "Only invited accounts have activation links");
  }
  const token = await issueInvitation(user.id, actor.id);
  await audit("INVITATION_REISSUED", actor.id, userId);
  return token;
}

export function publicUser(user: User & { clinic?: { id: string; name: string } | null }) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    title: user.title,
    department: user.department,
    clinic: user.clinic ? { id: user.clinic.id, name: user.clinic.name } : null,
  };
}
