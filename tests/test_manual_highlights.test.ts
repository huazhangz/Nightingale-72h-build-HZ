import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHumanHighlight } from "../src/lib/care-note/highlights";
import { prisma } from "../src/lib/db";
import { createNoteFixture, deleteNoteFixture } from "./helpers/fixtures";
import type { Actor } from "../src/lib/auth/rbac";
import { ForbiddenError } from "../src/lib/auth/rbac";

describe("manual highlights", () => {
  let fixture: Awaited<ReturnType<typeof createNoteFixture>>;
  let clinician: Actor;
  let patient: Actor;

  beforeEach(async () => {
    fixture = await createNoteFixture("manual-hl");
    clinician = { id: fixture.clinician.id, role: "CLINICIAN", clinicId: fixture.clinic.id };
    patient = { id: fixture.patient.id, role: "PATIENT", clinicId: fixture.clinic.id };
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

  it("lets clinicians store HUMAN highlights with their role", async () => {
    const highlight = await createHumanHighlight(clinician, fixture.entry.id, {
      startOffset: 0,
      endOffset: 8,
      excerpt: "Observed",
      label: "PATIENT_INSIGHT",
    });
    expect(highlight.source).toBe("HUMAN");
    expect(highlight.label).toBe("PATIENT_INSIGHT");
    const stored = await prisma.highlight.findUniqueOrThrow({
      where: { id: highlight.id },
      include: { createdBy: true },
    });
    expect(stored.createdBy.role).toBe("CLINICIAN");
  });

  it("blocks patients from creating highlights", async () => {
    await expect(
      createHumanHighlight(patient, fixture.entry.id, {
        startOffset: 0,
        endOffset: 8,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
