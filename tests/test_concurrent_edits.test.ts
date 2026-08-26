import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConflictError } from "../src/lib/auth/conflict";
import { applyOptimisticEdit, mergeBodies } from "../src/lib/care-note/concurrency";
import { prisma } from "../src/lib/db";
import { createNoteFixture, deleteNoteFixture } from "./helpers/fixtures";

const BASE_BODY = ["Assessment: stable", "Plan: rest"].join("\n");
const STAFF_BODY = ["Assessment: staff vitals logged", "Plan: rest", "Staff task: bill"].join("\n");
const CLINICIAN_BODY = ["Assessment: clinician impression", "Plan: rest"].join("\n");

describe("concurrent edits", () => {
  let fixture: Awaited<ReturnType<typeof createNoteFixture>> & { staff?: { id: string } };

  beforeEach(async () => {
    fixture = await createNoteFixture("concurrent");
    fixture.staff = await prisma.user.create({
      data: {
        email: `staff-${fixture.clinic.slug}@nightingale.test`,
        name: "Sam Staff",
        role: "STAFF",
        passwordHash: "dev-only-not-a-real-hash",
        clinicId: fixture.clinic.id,
      },
    });
    await prisma.careEntry.update({
      where: { id: fixture.entry.id },
      data: { body: BASE_BODY, version: 1, authorId: fixture.staff.id },
    });
  });

  afterEach(async () => {
    if (!fixture) {
      return;
    }
    await deleteNoteFixture({
      clinicId: fixture.clinic.id,
      userIds: [fixture.patient.id, fixture.clinician.id, fixture.staff!.id],
      entryId: fixture.entry.id,
    });
  });

  it("merges with clinician precedence on conflicting lines", () => {
    const merged = mergeBodies(BASE_BODY, STAFF_BODY, CLINICIAN_BODY, "CLINICIAN");
    expect(merged).toBe(
      ["Assessment: clinician impression", "Plan: rest", "Staff task: bill"].join("\n"),
    );
  });

  it("rejects a stale patch with 409 conflict and leaves the latest body unchanged", async () => {
    const staffEdit = await applyOptimisticEdit({
      entryId: fixture.entry.id,
      userId: fixture.staff!.id,
      newContent: STAFF_BODY,
      baseVersion: 1,
    });
    expect(staffEdit.conflict).toBe(false);
    expect(staffEdit.entry.version).toBe(2);

    await expect(
      applyOptimisticEdit({
        entryId: fixture.entry.id,
        userId: fixture.clinician.id,
        newContent: CLINICIAN_BODY,
        baseVersion: 1,
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    try {
      await applyOptimisticEdit({
        entryId: fixture.entry.id,
        userId: fixture.clinician.id,
        newContent: CLINICIAN_BODY,
        baseVersion: 1,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).code).toBe("CONFLICT");
      expect((error as ConflictError).currentVersion).toBe(2);
      expect((error as ConflictError).currentBody).toBe(STAFF_BODY);
    }

    const stored = await prisma.careEntry.findUniqueOrThrow({ where: { id: fixture.entry.id } });
    expect(stored.body).toBe(STAFF_BODY);
    expect(stored.version).toBe(2);
    expect(ConflictError).toBeDefined();
  });

  it("applies when baseVersion matches the stored version", async () => {
    await applyOptimisticEdit({
      entryId: fixture.entry.id,
      userId: fixture.staff!.id,
      newContent: STAFF_BODY,
      baseVersion: 1,
    });

    const second = await applyOptimisticEdit({
      entryId: fixture.entry.id,
      userId: fixture.staff!.id,
      newContent: `${STAFF_BODY}\nNote: reviewed.`,
      baseVersion: 2,
    });
    expect(second.conflict).toBe(false);
    expect(second.entry.version).toBe(3);
  });

  it("blocks staff from patching a clinician-authored diagnosis", async () => {
    const diagnosis = await prisma.careEntry.create({
      data: {
        clinicId: fixture.clinic.id,
        patientId: fixture.patient.id,
        authorId: fixture.clinician.id,
        title: "Clinician diagnosis",
        body: CLINICIAN_BODY,
        version: 1,
        status: "SUBMITTED",
        encounterAt: new Date("2026-08-26T12:00:00.000Z"),
      },
    });
    await expect(
      applyOptimisticEdit({
        entryId: diagnosis.id,
        userId: fixture.staff!.id,
        newContent: STAFF_BODY,
        baseVersion: 1,
      }),
    ).rejects.toThrow(/cannot write or edit clinician notes/);
    await prisma.entryRevision.deleteMany({ where: { careEntryId: diagnosis.id } });
    await prisma.auditLog.deleteMany({ where: { entityId: diagnosis.id } });
    await prisma.careEntry.delete({ where: { id: diagnosis.id } });
  });
});
