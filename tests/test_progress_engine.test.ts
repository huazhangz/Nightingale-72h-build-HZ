import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError } from "../src/lib/auth/rbac";
import {
  deriveConsultationStage,
  recordEntryViews,
  releaseFinalSummary,
  syncConsultationStage,
} from "../src/lib/care-note/progress-engine";
import { getPatientTimeline } from "../src/lib/care-note/timeline";
import { prisma } from "../src/lib/db";
import { createNoteFixture, deleteNoteFixture } from "./helpers/fixtures";
import type { Actor } from "../src/lib/auth/rbac";

describe("consultation progress engine", () => {
  it("maps viewers and distinct contributors onto the four stages", () => {
    expect(deriveConsultationStage({ current: "SUBMITTED", viewerCount: 0, contributorCount: 1 })).toBe(
      "SUBMITTED",
    );
    expect(deriveConsultationStage({ current: "SUBMITTED", viewerCount: 1, contributorCount: 1 })).toBe(
      "CLINICIAN_REVIEWING",
    );
    expect(deriveConsultationStage({ current: "CLINICIAN_REVIEWING", viewerCount: 1, contributorCount: 2 })).toBe(
      "MDT_CONSULTATION",
    );
    expect(deriveConsultationStage({ current: "FINAL_SUMMARY", viewerCount: 0, contributorCount: 1 })).toBe(
      "FINAL_SUMMARY",
    );
  });

  let fixture: Awaited<ReturnType<typeof createNoteFixture>> & { staff?: { id: string } };
  let staff: Actor;
  let clinician: Actor;
  let patient: Actor;

  beforeEach(async () => {
    fixture = await createNoteFixture("progress");
    fixture.staff = await prisma.user.create({
      data: {
        email: `staff-${fixture.clinic.slug}@nightingale.test`,
        name: "Sam Staff",
        role: "STAFF",
        passwordHash: "dev-only-not-a-real-hash",
        clinicId: fixture.clinic.id,
      },
    });
    staff = { id: fixture.staff.id, role: "STAFF", clinicId: fixture.clinic.id };
    clinician = { id: fixture.clinician.id, role: "CLINICIAN", clinicId: fixture.clinic.id };
    patient = { id: fixture.patient.id, role: "PATIENT", clinicId: fixture.clinic.id };
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

  it("advances to in-review on first staff or clinician view", async () => {
    await recordEntryViews(staff, [fixture.entry.id]);
    const stored = await prisma.careEntry.findUniqueOrThrow({ where: { id: fixture.entry.id } });
    expect(stored.consultationStage).toBe("CLINICIAN_REVIEWING");
  });

  it("advances to MDT when two clinical users contribute", async () => {
    await prisma.comment.create({
      data: {
        careEntryId: fixture.entry.id,
        authorId: fixture.staff!.id,
        body: "Plan: nursing follow-up.",
      },
    });
    expect(await syncConsultationStage(fixture.entry.id)).toBe("MDT_CONSULTATION");
  });

  it("lets only clinicians release the patient-facing summary", async () => {
    await expect(releaseFinalSummary(staff, fixture.entry.id)).rejects.toBeInstanceOf(ForbiddenError);
    await releaseFinalSummary(clinician, fixture.entry.id);
    const [patientEntry] = await getPatientTimeline(fixture.patient.id, patient);
    expect(patientEntry.summaryReleased).toBe(true);
    expect(patientEntry.patientFacingSummary).toContain("Observed cough");
    expect(patientEntry.consultationStage).toBe("FINAL_SUMMARY");
  });
});
