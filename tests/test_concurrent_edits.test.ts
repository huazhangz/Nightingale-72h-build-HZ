import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("does not silently overwrite a concurrent staff edit without a revision snapshot", async () => {
    const staffEdit = await applyOptimisticEdit({
      entryId: fixture.entry.id,
      userId: fixture.staff!.id,
      newContent: STAFF_BODY,
      baseVersion: 1,
    });
    expect(staffEdit.conflict).toBe(false);
    expect(staffEdit.entry.version).toBe(2);

    const clinicianEdit = await applyOptimisticEdit({
      entryId: fixture.entry.id,
      userId: fixture.clinician.id,
      newContent: CLINICIAN_BODY,
      baseVersion: 1,
    });

    expect(clinicianEdit.conflict).toBe(true);
    expect(clinicianEdit.resolution).toBe("merged-clinician-precedence");
    expect(clinicianEdit.entry.body).toContain("Assessment: clinician impression");
    expect(clinicianEdit.entry.body).toContain("Staff task: bill");
    expect(clinicianEdit.entry.body).not.toContain("Assessment: staff vitals logged");

    const revisions = await prisma.entryRevision.findMany({
      where: { careEntryId: fixture.entry.id },
      orderBy: { version: "asc" },
    });

    expect(revisions.map((revision) => revision.body)).toContain(BASE_BODY);
    expect(revisions.map((revision) => revision.body)).toContain(STAFF_BODY);
    expect(revisions.some((revision) => revision.summary === "pre-conflict-snapshot")).toBe(true);

    const audit = await prisma.auditLog.findMany({
      where: { entityId: fixture.entry.id, action: "NOTE_EDIT" },
    });
    expect(audit.length).toBeGreaterThanOrEqual(2);
    expect(audit.some((row) => row.actorId === fixture.clinician.id)).toBe(true);
    expect(JSON.stringify(audit)).not.toContain("staff vitals");
  });

  it("keeps clinician content when merging a stale clinician edit on a staff note", async () => {
    await applyOptimisticEdit({
      entryId: fixture.entry.id,
      userId: fixture.clinician.id,
      newContent: CLINICIAN_BODY,
      baseVersion: 1,
    });

    const staffLate = await applyOptimisticEdit({
      entryId: fixture.entry.id,
      userId: fixture.staff!.id,
      newContent: STAFF_BODY,
      baseVersion: 1,
    });

    expect(staffLate.conflict).toBe(true);
    expect(staffLate.entry.body).toContain("Assessment: clinician impression");
    expect(staffLate.entry.body).toContain("Staff task: bill");

    const lostClinician = await prisma.entryRevision.findFirst({
      where: { careEntryId: fixture.entry.id, body: CLINICIAN_BODY },
    });
    expect(lostClinician).not.toBeNull();
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
