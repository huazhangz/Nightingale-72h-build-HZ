import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyPatientLogin, verifyStaffLogin } from "../src/lib/auth/login";
import { prisma } from "../src/lib/db";
import { createNoteFixture, deleteNoteFixture } from "./helpers/fixtures";

describe("role login verification", () => {
  let fixture: Awaited<ReturnType<typeof createNoteFixture>> & { staffId?: string };

  beforeEach(async () => {
    fixture = await createNoteFixture("login");
    await prisma.user.update({
      where: { id: fixture.patient.id },
      data: {
        name: "张伟 (Zhang Wei)",
        phone: `137${String(Date.now()).slice(-8)}`.slice(0, 11),
        dateOfBirth: "1985-06-15",
      },
    });
    const patient = await prisma.user.findUniqueOrThrow({ where: { id: fixture.patient.id } });
    fixture.patient = patient;
    const staff = await prisma.user.create({
      data: {
        email: `staff-login-${fixture.clinic.slug}@nightingale.test`,
        name: "Sam Staff",
        role: "STAFF",
        passwordHash: "dev-only-not-a-real-hash",
        clinicId: fixture.clinic.id,
        employeeCode: String(800000 + (Date.now() % 99999)),
      },
    });
    fixture.staffId = staff.id;
  });

  afterEach(async () => {
    if (!fixture) {
      return;
    }
    await deleteNoteFixture({
      clinicId: fixture.clinic.id,
      userIds: [fixture.patient.id, fixture.clinician.id, fixture.staffId!],
      entryId: fixture.entry.id,
    });
  });

  it("accepts Zhang Wei name aliases with matching phone and date of birth", async () => {
    const phone = fixture.patient.phone ?? "";
    const byLatin = await verifyPatientLogin({
      fullName: "Zhang Wei",
      phone,
      dateOfBirth: "1985-06-15",
    });
    const byHan = await verifyPatientLogin({
      fullName: "张伟",
      phone,
      dateOfBirth: "1985-06-15",
    });
    expect(byLatin?.id).toBe(fixture.patient.id);
    expect(byHan?.id).toBe(fixture.patient.id);
    expect(
      await verifyPatientLogin({
        fullName: "Zhang Wei",
        phone,
        dateOfBirth: "1999-01-01",
      }),
    ).toBeNull();
  });

  it("accepts a 6-digit staff code only with a non-empty second factor", async () => {
    const staff = await prisma.user.findUniqueOrThrow({ where: { id: fixture.staffId } });
    const ok = await verifyStaffLogin({
      role: "STAFF",
      employeeCode: staff.employeeCode ?? "",
      verification: staff.employeeCode ?? "",
    });
    expect(ok?.id).toBe(staff.id);
    expect(
      await verifyStaffLogin({
        role: "STAFF",
        employeeCode: staff.employeeCode ?? "",
        verification: "   ",
      }),
    ).toBeNull();
    expect(
      await verifyStaffLogin({
        role: "STAFF",
        employeeCode: staff.employeeCode ?? "",
        verification: "wrong-secret",
      }),
    ).toBeNull();
    expect(
      await verifyStaffLogin({
        role: "CLINICIAN",
        employeeCode: staff.employeeCode ?? "",
        verification: staff.employeeCode ?? "",
      }),
    ).toBeNull();
  });
});
