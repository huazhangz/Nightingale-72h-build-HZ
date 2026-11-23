import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authenticate, AuthError, MAX_FAILED_LOGINS } from "../src/lib/auth/accounts";
import { hashPassword, passwordIssues, verifyPassword } from "../src/lib/auth/password";
import { requireActor, UnauthorizedError } from "../src/lib/auth/session";
import { ForbiddenError } from "../src/lib/auth/rbac";
import { readCookie, SESSION_COOKIE, sessionCookie, signSession, verifySession } from "../src/lib/auth/session-token";
import {
  handleActivate,
  handlePasswordReset,
  handleChangePassword,
  handleCreatePatient,
  handleDemoAccounts,
  handleInviteUser,
  handleLogin,
  handleMe,
  handleRegister,
  handleSignOutEverywhere,
  handleUpdateUser,
} from "../src/lib/api/auth-handlers";
import { prisma } from "../src/lib/db";

const PASSWORD = "Correct-Horse-42";
const HOST = "nightingale.test";

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://${HOST}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", host: HOST, ...headers },
    body: JSON.stringify(body),
  });
}

function cookieFrom(response: Response): string {
  const token = readCookie((response.headers.get("set-cookie") ?? "").split(";")[0] ?? "", SESSION_COOKIE);
  return `${SESSION_COOKIE}=${token}`;
}

describe("password hashing and policy", () => {
  it("hashes with scrypt and verifies in constant shape", async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword("wrong-password-1", hash)).toBe(false);
    expect(await verifyPassword(PASSWORD, "!service-account")).toBe(false);
    expect(await verifyPassword(PASSWORD, null)).toBe(false);
  });

  it("enforces length, letters, digits, no email reuse, no common passwords", () => {
    expect(passwordIssues("short1")).toContain("TOO_SHORT");
    expect(passwordIssues("onlyletterslong")).toContain("NEEDS_DIGIT");
    expect(passwordIssues("1234567890123")).toContain("NEEDS_LETTER");
    expect(passwordIssues("elena-rossi-2026", { email: "elena-rossi@x.test" })).toContain("CONTAINS_EMAIL");
    expect(passwordIssues("password123")).toContain("TOO_COMMON");
    expect(passwordIssues(PASSWORD)).toEqual([]);
  });
});

describe("signed sessions", () => {
  it("round-trips, carries the session version, and rejects tampering and expiry", () => {
    const token = signSession("user-1", 3);
    expect(verifySession(token)).toMatchObject({ sub: "user-1", sv: 3 });
    const [, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "user-2", sv: 3, iat: 0, exp: 9_999_999_999 })).toString("base64url");
    expect(verifySession(`${forged}.${signature}`)).toBeNull();
    const issued = new Date("2026-01-01T00:00:00Z");
    expect(verifySession(signSession("u", 0, issued, 60), new Date("2026-01-01T00:01:00Z"))).toBeNull();
    expect(sessionCookie("abc")).toMatch(/HttpOnly; SameSite=Lax/);
  });
});

describe("accounts", () => {
  let clinicId: string;
  let enrollmentCode: string;
  const ids: string[] = [];
  const suffix = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  async function user(role: "ADMIN" | "STAFF" | "CLINICIAN" | "PATIENT", extra: Record<string, unknown> = {}) {
    const created = await prisma.user.create({
      data: {
        email: `${role.toLowerCase()}-${suffix()}@auth.test`,
        name: `Test ${role}`,
        role,
        clinicId,
        passwordHash: await hashPassword(PASSWORD),
        ...extra,
      },
    });
    ids.push(created.id);
    return created;
  }

  async function signIn(email: string, password = PASSWORD) {
    return handleLogin(post("/api/auth/login", { email, password }, { origin: `http://${HOST}`, "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 250)}` }));
  }

  beforeEach(async () => {
    enrollmentCode = `CODE-${suffix()}`;
    const clinic = await prisma.clinic.create({ data: { name: "Auth clinic", slug: `auth-${suffix()}`, enrollmentCode } });
    clinicId = clinic.id;
  });

  afterEach(async () => {
    const all = await prisma.user.findMany({ where: { clinicId }, select: { id: true } });
    const userIds = [...new Set([...ids, ...all.map((row) => row.id)])];
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: userIds } }, { entityId: { in: userIds } }] } });
    await prisma.invitation.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.clinic.deleteMany({ where: { id: clinicId } });
    ids.length = 0;
  });

  it("signs in with email and password and sets a session that requireActor accepts", async () => {
    const clinician = await user("CLINICIAN");
    const response = await signIn(clinician.email.toUpperCase());
    expect(response.status).toBe(200);
    const actor = await requireActor(new Request(`http://${HOST}/api/x`, { headers: { cookie: cookieFrom(response) } }));
    expect(actor).toEqual({ id: clinician.id, role: "CLINICIAN", clinicId });
    const me = await handleMe(new Request(`http://${HOST}/api/auth/me`, { headers: { cookie: cookieFrom(response) } }));
    expect((await me.json()).user).toMatchObject({ id: clinician.id, clinic: { id: clinicId } });
    expect((await handleMe(new Request(`http://${HOST}/api/auth/me`))).status).toBe(401);
  });

  it("returns one generic error for unknown emails, wrong passwords and locked accounts", async () => {
    const staff = await user("STAFF");
    const unknown = await signIn("nobody@auth.test");
    const wrong = await signIn(staff.email, "Wrong-Password-1");
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect((await unknown.json()).error).toBe((await wrong.json()).error);
  });

  it(`locks the account after ${MAX_FAILED_LOGINS} failures, even for the right password`, async () => {
    const staff = await user("STAFF");
    for (let attempt = 0; attempt < MAX_FAILED_LOGINS; attempt += 1) {
      await expect(authenticate({ email: staff.email, password: "Wrong-Password-1", clientKey: `lock-${attempt}` })).rejects.toBeInstanceOf(AuthError);
    }
    const locked = await prisma.user.findUniqueOrThrow({ where: { id: staff.id } });
    expect(locked.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    await expect(authenticate({ email: staff.email, password: PASSWORD, clientKey: "lock-ok" })).rejects.toBeInstanceOf(AuthError);
  });

  it("refuses service accounts, invited and disabled users", async () => {
    const service = await user("CLINICIAN", { isServiceAccount: true });
    const invited = await user("STAFF", { status: "INVITED" });
    const disabled = await user("STAFF", { status: "DISABLED" });
    for (const account of [service, invited, disabled]) {
      expect((await signIn(account.email)).status).toBe(401);
    }
  });

  it("revokes sessions on password change, sign-out-everywhere and disable", async () => {
    const admin = await user("ADMIN");
    const clinician = await user("CLINICIAN");
    const first = cookieFrom(await signIn(clinician.email));
    const changed = await handleChangePassword(post("/api/auth/password", { currentPassword: PASSWORD, newPassword: "Brand-New-Pass-77" }, { cookie: first }));
    expect(changed.status).toBe(200);
    const second = cookieFrom(changed);
    await expect(requireActor(new Request(`http://${HOST}/x`, { headers: { cookie: first } }))).rejects.toBeInstanceOf(UnauthorizedError);
    expect((await requireActor(new Request(`http://${HOST}/x`, { headers: { cookie: second } }))).id).toBe(clinician.id);

    await handleSignOutEverywhere(post("/api/auth/sessions/revoke", {}, { cookie: second }));
    await expect(requireActor(new Request(`http://${HOST}/x`, { headers: { cookie: second } }))).rejects.toBeInstanceOf(UnauthorizedError);

    const third = cookieFrom(await signIn(clinician.email, "Brand-New-Pass-77"));
    const adminCookie = cookieFrom(await signIn(admin.email));
    const disable = new Request(`http://${HOST}/api/admin/users/${clinician.id}`, {
      method: "PATCH",
      headers: { cookie: adminCookie, "content-type": "application/json", host: HOST },
      body: JSON.stringify({ status: "DISABLED" }),
    });
    expect((await handleUpdateUser(disable, clinician.id)).status).toBe(200);
    await expect(requireActor(new Request(`http://${HOST}/x`, { headers: { cookie: third } }))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("blocks cross-site state-changing requests", async () => {
    const clinician = await user("CLINICIAN");
    const cookie = cookieFrom(await signIn(clinician.email));
    const foreign = new Request(`http://${HOST}/api/x`, { method: "POST", headers: { cookie, host: HOST, origin: "https://evil.example" } });
    await expect(requireActor(foreign)).rejects.toBeInstanceOf(ForbiddenError);
    const sameSite = new Request(`http://${HOST}/api/x`, { method: "POST", headers: { cookie, host: HOST, origin: `http://${HOST}` } });
    expect((await requireActor(sameSite)).id).toBe(clinician.id);
    const crossLogin = await handleLogin(post("/api/auth/login", { email: clinician.email, password: PASSWORD }, { origin: "https://evil.example" }));
    expect(crossLogin.status).toBe(403);
  });

  it("registers patients only with a valid clinic code and a strong password", async () => {
    const base = { name: "New Patient", email: `new-${suffix()}@auth.test`, password: "Patient-Pass-99", dateOfBirth: "1990-05-05" };
    expect((await handleRegister(post("/api/auth/register", { ...base, clinicCode: "WRONG" }))).status).toBe(400);
    expect((await handleRegister(post("/api/auth/register", { ...base, clinicCode: enrollmentCode, password: "weak" }))).status).toBe(400);
    const created = await handleRegister(post("/api/auth/register", { ...base, clinicCode: enrollmentCode }));
    expect(created.status).toBe(201);
    const actor = await requireActor(new Request(`http://${HOST}/x`, { headers: { cookie: cookieFrom(created) } }));
    expect(actor).toMatchObject({ role: "PATIENT", clinicId });
    expect((await handleRegister(post("/api/auth/register", { ...base, clinicCode: enrollmentCode }))).status).toBe(409);
  });

  it("limits unauthenticated registration attempts per client address", async () => {
    const from = { "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 200) + 1}` };
    const attempt = () => handleRegister(post("/api/auth/register", { clinicCode: "GUESS", name: "x", email: "x@y.z", password: "p", dateOfBirth: "" }, from));
    for (let i = 0; i < 10; i += 1) {
      expect((await attempt()).status).toBe(400);
    }
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("lets admins invite staff, who activate once with a one-time link", async () => {
    const admin = await user("ADMIN");
    const staff = await user("STAFF");
    const adminCookie = cookieFrom(await signIn(admin.email));
    const staffCookie = cookieFrom(await signIn(staff.email));
    const email = `invitee-${suffix()}@auth.test`;
    expect((await handleInviteUser(post("/api/admin/users", { email, name: "New Doc", role: "CLINICIAN" }, { cookie: staffCookie }))).status).toBe(403);
    expect((await handleInviteUser(post("/api/admin/users", { email, name: "Bad", role: "PATIENT" }, { cookie: adminCookie }))).status).toBe(400);
    const invited = await handleInviteUser(post("/api/admin/users", { email, name: "New Doc", role: "CLINICIAN" }, { cookie: adminCookie }));
    expect(invited.status).toBe(201);
    const { activationUrl } = (await invited.json()) as { activationUrl: string };
    const token = new URL(activationUrl).searchParams.get("token")!;
    expect((await signIn(email)).status).toBe(401);

    const activated = await handleActivate(post("/api/auth/activate", { token, password: "Doctor-Pass-123" }));
    expect(activated.status).toBe(200);
    expect((await signIn(email, "Doctor-Pass-123")).status).toBe(200);
    expect((await handleActivate(post("/api/auth/activate", { token, password: "Doctor-Pass-456" }))).status).toBe(400);
  });

  it("lets admins issue a one-time password reset that signs out old sessions when used", async () => {
    const admin = await user("ADMIN");
    const staff = await user("STAFF");
    const other = await user("STAFF");
    const adminCookie = cookieFrom(await signIn(admin.email));
    const staffCookie = cookieFrom(await signIn(staff.email));
    expect((await handlePasswordReset(post(`/api/admin/users/${other.id}/password-reset`, {}, { cookie: staffCookie }), other.id)).status).toBe(403);

    const issued = await handlePasswordReset(post(`/api/admin/users/${staff.id}/password-reset`, {}, { cookie: adminCookie }), staff.id);
    expect(issued.status).toBe(200);
    const token = new URL(((await issued.json()) as { resetUrl: string }).resetUrl).searchParams.get("token")!;
    // Until the link is used, the current password and session keep working.
    expect((await requireActor(new Request(`http://${HOST}/x`, { headers: { cookie: staffCookie } }))).id).toBe(staff.id);

    expect((await handleActivate(post("/api/auth/activate", { token, password: "Reset-Pass-2026" }))).status).toBe(200);
    await expect(requireActor(new Request(`http://${HOST}/x`, { headers: { cookie: staffCookie } }))).rejects.toThrow();
    expect((await signIn(staff.email)).status).toBe(401);
    expect((await signIn(staff.email, "Reset-Pass-2026")).status).toBe(200);
    expect((await handleActivate(post("/api/auth/activate", { token, password: "Reset-Pass-2027" }))).status).toBe(400);
  });

  it("lets clinical staff create patient records, with an optional portal invitation", async () => {
    const staff = await user("STAFF");
    const patient = await user("PATIENT");
    const staffCookie = cookieFrom(await signIn(staff.email));
    const patientCookie = cookieFrom(await signIn(patient.email));
    expect((await handleCreatePatient(post("/api/patients", { name: "Ana Example", dateOfBirth: "1970-01-01" }, { cookie: patientCookie }))).status).toBe(403);
    const noPortal = await handleCreatePatient(post("/api/patients", { name: "Ana Example", dateOfBirth: "1970-01-01" }, { cookie: staffCookie }));
    expect((await noPortal.json()) as unknown).toMatchObject({ patient: { status: "ACTIVE" }, activationUrl: null });
    const withPortal = await handleCreatePatient(
      post("/api/patients", { name: "Ben Example", dateOfBirth: "1971-02-02", email: `ben-${suffix()}@auth.test` }, { cookie: staffCookie }),
    );
    expect((await withPortal.json()) as unknown).toMatchObject({ patient: { status: "INVITED" }, activationUrl: expect.stringContaining("/activate?token=") });
  });

  it("serves demo sign-in shortcuts only in demo mode", async () => {
    const saved = process.env.NIGHTINGALE_DEMO_MODE;
    delete process.env.NIGHTINGALE_DEMO_MODE;
    expect((await handleDemoAccounts()).status).toBe(404);
    process.env.NIGHTINGALE_DEMO_MODE = "true";
    expect((await handleDemoAccounts()).status).toBe(200);
    if (saved === undefined) delete process.env.NIGHTINGALE_DEMO_MODE;
    else process.env.NIGHTINGALE_DEMO_MODE = saved;
  });
});
