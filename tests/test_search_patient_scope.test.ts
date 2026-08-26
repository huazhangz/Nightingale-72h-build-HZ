import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError } from "../src/lib/auth/rbac";
import { searchPatientEntries } from "../src/lib/care-note/search";
import { getPatientTimeline } from "../src/lib/care-note/timeline";
import { prisma } from "../src/lib/db";
import { createNoteFixture, deleteNoteFixture } from "./helpers/fixtures";
import type { Actor } from "../src/lib/auth/rbac";

describe("patient search and isolation", () => {
  let fixture: Awaited<ReturnType<typeof createNoteFixture>>;
  let other: Awaited<ReturnType<typeof createNoteFixture>>;
  let patientActor: Actor;
  let clinicianActor: Actor;

  beforeEach(async () => {
    fixture = await createNoteFixture("search-a");
    other = await createNoteFixture("search-b");
    await prisma.careEntry.update({
      where: { id: fixture.entry.id },
      data: {
        body: "Observed cough and fever. Plan rest and fluids.\nSecret diagnosis: aortic stenosis. Internal clinician narrative.",
      },
    });
    patientActor = { id: fixture.patient.id, role: "PATIENT", clinicId: fixture.clinic.id };
    clinicianActor = {
      id: fixture.clinician.id,
      role: "CLINICIAN",
      clinicId: fixture.clinic.id,
    };
  });

  afterEach(async () => {
    if (other) {
      await deleteNoteFixture({
        clinicId: other.clinic.id,
        userIds: [other.patient.id, other.clinician.id],
        entryId: other.entry.id,
      });
    }
    if (fixture) {
      await deleteNoteFixture({
        clinicId: fixture.clinic.id,
        userIds: [fixture.patient.id, fixture.clinician.id],
        entryId: fixture.entry.id,
      });
    }
  });

  it("returns only the patient's facing summary and never raw body or other patients", async () => {
    const hits = await searchPatientEntries(fixture.patient.id, patientActor, "stenosis");
    expect(hits).toHaveLength(0);

    const ownHits = await searchPatientEntries(fixture.patient.id, patientActor, "Visit");
    expect(ownHits).toHaveLength(1);
    expect(ownHits[0]?.body).toBeUndefined();
    expect(ownHits[0]?.patientFacingSummary).toBe("");
    expect(JSON.stringify(ownHits)).not.toMatch(/aortic stenosis/i);
    expect(JSON.stringify(ownHits)).not.toMatch(/Internal clinician/);

    await expect(searchPatientEntries(other.patient.id, patientActor, "")).rejects.toThrow(
      ForbiddenError,
    );
    await expect(getPatientTimeline(other.patient.id, patientActor)).rejects.toThrow(
      ForbiddenError,
    );
  });

  it("lets clinicians search raw notes for the selected patient only", async () => {
    const hits = await searchPatientEntries(fixture.patient.id, clinicianActor, "aortic");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.body).toMatch(/aortic stenosis/);
    await expect(searchPatientEntries(other.patient.id, clinicianActor, "aortic")).rejects.toThrow(
      ForbiddenError,
    );

    const extra = await prisma.careEntry.create({
      data: {
        clinicId: fixture.clinic.id,
        patientId: fixture.patient.id,
        authorId: fixture.clinician.id,
        title: "Older visit",
        body: "Historical cough note.",
        version: 1,
        encounterAt: new Date("2025-01-01T10:00:00.000Z"),
      },
    });
    const newest = await searchPatientEntries(fixture.patient.id, clinicianActor, "", {
      sort: "newest",
    });
    const oldest = await searchPatientEntries(fixture.patient.id, clinicianActor, "", {
      sort: "oldest",
    });
    expect(newest[0]?.title).not.toBe("Older visit");
    expect(oldest[0]?.title).toBe("Older visit");
    const ranged = await searchPatientEntries(fixture.patient.id, clinicianActor, "", {
      from: "2099-01-01",
      to: "2099-12-31",
    });
    expect(ranged).toHaveLength(0);
    await prisma.careEntry.delete({ where: { id: extra.id } });
  });
});
