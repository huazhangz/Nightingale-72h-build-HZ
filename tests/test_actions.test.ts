import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPatientAction, patchPatientAction } from "../src/lib/care-note/actions";
import { getGlanceCard } from "../src/lib/care-note/glance";
import { clearGlanceCache } from "../src/lib/cache/glanceCache";
import { ForbiddenError, type Actor } from "../src/lib/auth/rbac";
import { createNoteFixture, deleteNoteFixture } from "./helpers/fixtures";

describe("care actions", () => {
  let fixture: Awaited<ReturnType<typeof createNoteFixture>>;
  let clinician: Actor;
  let patient: Actor;

  beforeEach(async () => {
    clearGlanceCache();
    fixture = await createNoteFixture("actions");
    clinician = {
      id: fixture.clinician.id,
      role: "CLINICIAN",
      clinicId: fixture.clinic.id,
    };
    patient = {
      id: fixture.patient.id,
      role: "PATIENT",
      clinicId: fixture.clinic.id,
    };
  });

  afterEach(async () => {
    clearGlanceCache();
    if (!fixture) {
      return;
    }
    await deleteNoteFixture({
      clinicId: fixture.clinic.id,
      userIds: [fixture.patient.id, fixture.clinician.id],
      entryId: fixture.entry.id,
    });
  });

  it("lets clinicians create, retag, and resolve actions that then leave the unresolved list", async () => {
    const created = await createPatientAction(clinician, fixture.patient.id, {
      text: "Order STAT CT if pain recurs",
      kind: "lab_order",
    });
    expect(created.status).toBe("PENDING");
    expect(created.kind).toBe("lab_order");

    const tagged = await patchPatientAction(clinician, fixture.patient.id, created.id, {
      kind: "follow_up",
    });
    expect(tagged.kind).toBe("follow_up");

    const before = await getGlanceCard(fixture.patient.id, clinician);
    expect(before.card.unresolvedActions.some((action) => action.id === created.id)).toBe(true);

    const resolved = await patchPatientAction(clinician, fixture.patient.id, created.id, {
      status: "RESOLVED",
    });
    expect(resolved.status).toBe("RESOLVED");
    expect(resolved.resolvedByRole).toBe("CLINICIAN");

    clearGlanceCache();
    const after = await getGlanceCard(fixture.patient.id, clinician);
    expect(after.card.unresolvedActions.some((action) => action.id === created.id)).toBe(false);
    expect(after.card.resolvedActions?.some((action) => action.id === created.id)).toBe(true);
  });

  it("blocks patients from creating actions", async () => {
    await expect(
      createPatientAction(patient, fixture.patient.id, { text: "Patient-created task" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
