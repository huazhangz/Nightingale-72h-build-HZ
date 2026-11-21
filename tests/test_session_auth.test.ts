import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireActor, UnauthorizedError } from "../src/lib/auth/session";
import { namesMatch } from "../src/lib/auth/login";
import {
  SESSION_COOKIE,
  readCookie,
  sessionCookie,
  signSession,
  verifySession,
} from "../src/lib/auth/session-token";
import { handleLogin } from "../src/lib/api/handlers";
import { prisma } from "../src/lib/db";
import { createNoteFixture, deleteNoteFixture } from "./helpers/fixtures";

describe("signed session tokens", () => {
  it("round-trips a valid token", () => {
    const token = signSession("user-1");
    expect(verifySession(token)?.sub).toBe("user-1");
  });

  it("rejects tampered payloads and signatures", () => {
    const token = signSession("user-1");
    const [payload, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "user-2", iat: 0, exp: 9_999_999_999 })).toString("base64url");
    expect(verifySession(`${forged}.${signature}`)).toBeNull();
    expect(verifySession(`${payload}.${signature}x`)).toBeNull();
    expect(verifySession(`${payload}`)).toBeNull();
    expect(verifySession(`${payload}.${signature}.extra`)).toBeNull();
    expect(verifySession("")).toBeNull();
  });

  it("rejects expired tokens", () => {
    const issued = new Date("2026-01-01T00:00:00Z");
    const token = signSession("user-1", issued, 60);
    expect(verifySession(token, new Date("2026-01-01T00:00:30Z"))?.sub).toBe("user-1");
    expect(verifySession(token, new Date("2026-01-01T00:01:00Z"))).toBeNull();
  });

  it("builds an HttpOnly SameSite cookie and parses it back", () => {
    const cookie = sessionCookie("abc.def");
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(readCookie(`other=1; ${SESSION_COOKIE}=abc.def`, SESSION_COOKIE)).toBe("abc.def");
  });
});

describe("requireActor", () => {
  let fixture: Awaited<ReturnType<typeof createNoteFixture>>;
  const originalFlag = process.env.NIGHTINGALE_ALLOW_HEADER_AUTH;

  beforeEach(async () => {
    fixture = await createNoteFixture("session");
  });

  afterEach(async () => {
    process.env.NIGHTINGALE_ALLOW_HEADER_AUTH = originalFlag;
    if (originalFlag === undefined) {
      delete process.env.NIGHTINGALE_ALLOW_HEADER_AUTH;
    }
    await deleteNoteFixture({
      clinicId: fixture.clinic.id,
      userIds: [fixture.patient.id, fixture.clinician.id],
      entryId: fixture.entry.id,
    });
  });

  it("resolves the actor from a signed session cookie", async () => {
    const request = new Request("http://test/api", {
      headers: { cookie: `${SESSION_COOKIE}=${signSession(fixture.clinician.id)}` },
    });
    const actor = await requireActor(request);
    expect(actor).toEqual({ id: fixture.clinician.id, role: "CLINICIAN", clinicId: fixture.clinic.id });
  });

  it("prefers the signed session over a conflicting x-user-id header", async () => {
    const request = new Request("http://test/api", {
      headers: {
        authorization: `Bearer ${signSession(fixture.patient.id)}`,
        "x-user-id": fixture.clinician.id,
      },
    });
    expect((await requireActor(request)).id).toBe(fixture.patient.id);
  });

  it("refuses raw x-user-id when header auth is disabled (production default)", async () => {
    process.env.NIGHTINGALE_ALLOW_HEADER_AUTH = "false";
    const request = new Request("http://test/api", { headers: { "x-user-id": fixture.clinician.id } });
    await expect(requireActor(request)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("still accepts x-user-id when header auth is enabled for the demo", async () => {
    process.env.NIGHTINGALE_ALLOW_HEADER_AUTH = "true";
    const request = new Request("http://test/api", { headers: { "x-user-id": fixture.clinician.id } });
    expect((await requireActor(request)).role).toBe("CLINICIAN");
  });

  it("sets a session cookie on successful login", async () => {
    await prisma.user.update({
      where: { id: fixture.patient.id },
      data: { name: "Ingrid Session", phone: "5559990001", dateOfBirth: "1990-02-02" },
    });
    const response = await handleLogin(
      new Request("http://test/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          role: "PATIENT",
          fullName: "Ingrid Session",
          phone: "555-999-0001",
          dateOfBirth: "1990-02-02",
        }),
      }),
    );
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") ?? "";
    const token = readCookie(cookie.split(";")[0] ?? "", SESSION_COOKIE);
    expect(verifySession(token)?.sub).toBe(fixture.patient.id);
  });
});

describe("patient name matching", () => {
  it("accepts exact and bilingual variants", () => {
    expect(namesMatch("Elena Rossi", "elena  rossi")).toBe(true);
    expect(namesMatch("张伟 (Zhang Wei)", "Zhang Wei")).toBe(true);
    expect(namesMatch("张伟 (Zhang Wei)", "张伟")).toBe(true);
  });

  it("rejects partial names that substring matching used to accept", () => {
    expect(namesMatch("Elena Rossi", "El")).toBe(false);
    expect(namesMatch("Elena Rossi", "Rossi")).toBe(false);
    expect(namesMatch("Elena Rossi", "Elena Rossi Bianchi")).toBe(false);
    expect(namesMatch("Elena Rossi", "")).toBe(false);
  });
});
