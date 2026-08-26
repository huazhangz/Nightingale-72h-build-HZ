import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { revertCareEntry, updateCareEntry } from "../src/lib/care-note/revision";
import { prisma } from "../src/lib/db";
import { createNoteFixture, deleteNoteFixture } from "./helpers/fixtures";

describe("revision history", () => {
  let fixture: Awaited<ReturnType<typeof createNoteFixture>>;

  beforeEach(async () => {
    fixture = await createNoteFixture("revision");
  });

  afterEach(async () => {
    if (!fixture) {
      return;
    }
    await deleteNoteFixture({
      clinicId: fixture.clinic.id,
      userIds: [fixture.patient.id, fixture.clinician.id],
      entryId: fixture.entry.id,
    });
  });

  it("increments the version counter when a note is edited", async () => {
    expect(fixture.entry.version).toBe(1);

    const updated = await updateCareEntry(
      fixture.entry.id,
      "Observed cough and fever. Started oral hydration.",
      fixture.clinician.id,
    );

    expect(updated.version).toBe(2);
    expect(updated.body).toBe("Observed cough and fever. Started oral hydration.");

    const snapshot = await prisma.entryRevision.findUniqueOrThrow({
      where: {
        careEntryId_version: { careEntryId: fixture.entry.id, version: 1 },
      },
    });
    expect(snapshot.body).toBe(fixture.entry.body);
  });

  it("reverts content to a prior historical state", async () => {
    const original = fixture.entry.body;
    await updateCareEntry(fixture.entry.id, "Revised plan: antibiotics.", fixture.clinician.id);
    await updateCareEntry(fixture.entry.id, "Latest plan: admission.", fixture.clinician.id);

    const reverted = await revertCareEntry(fixture.entry.id, 1, fixture.clinician.id);

    expect(reverted.body).toBe(original);
    expect(reverted.version).toBe(4);

    const currentSnapshot = await prisma.entryRevision.findUniqueOrThrow({
      where: {
        careEntryId_version: { careEntryId: fixture.entry.id, version: 3 },
      },
    });
    expect(currentSnapshot.body).toBe("Latest plan: admission.");
  });

  it("records AuditLog metadata of who changed what without storing raw PHI", async () => {
    const phiContent = "Follow up with S1234567A at jane.doe@clinic.sg or +65 91234567";
    const updated = await updateCareEntry(fixture.entry.id, phiContent, fixture.clinician.id);

    const log = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: fixture.entry.id, action: "NOTE_EDIT" },
    });

    expect(log.actorId).toBe(fixture.clinician.id);
    expect(log.metadata).toEqual({
      userId: fixture.clinician.id,
      entryId: fixture.entry.id,
      newVersion: updated.version,
    });

    const serialized = JSON.stringify(log.metadata);
    expect(serialized).not.toContain("S1234567A");
    expect(serialized).not.toContain("jane.doe@clinic.sg");
    expect(serialized).not.toContain("+65 91234567");
    expect(serialized).not.toContain(phiContent);
    expect(serialized).not.toMatch(/body|content|note/i);
  });
});
