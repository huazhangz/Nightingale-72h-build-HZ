import { createCareEntry } from "../../src/lib/care-note/entries";
import { prisma } from "../../src/lib/db";
import type { Actor } from "../../src/lib/auth/rbac";

export const NOTE_A_BODY =
  "Patient reports chest pain on exertion since Monday. Denies shortness of breath at rest. " +
  "Plan: order troponin and ECG today; follow-up in two days with results.";
export const NOTE_B_BODY = "Draft impression: considering cardiology referral. Fever noted overnight.";
export const NOTE_C_BODY = "Nursing check: nausea after meals, tolerating fluids. Home BP diary started.";

/** One clinic with a patient, a clinician, a nurse, three notes; plus a second clinic for isolation tests. */
export async function createAgentFixture(label: string) {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const clinic = await prisma.clinic.create({ data: { name: `Agent ${suffix}`, slug: `agent-${suffix}` } });
  const otherClinic = await prisma.clinic.create({ data: { name: `Other ${suffix}`, slug: `other-${suffix}` } });

  const user = (role: "PATIENT" | "STAFF" | "CLINICIAN", name: string, clinicId: string) =>
    prisma.user.create({
      data: {
        email: `${role.toLowerCase()}-${name.replace(/\s+/g, "")}-${suffix}@nightingale.test`,
        name,
        role,
        clinicId,
        passwordHash: "dev-only-not-a-real-hash",
      },
    });

  const patient = await user("PATIENT", "Pat Agent", clinic.id);
  const clinician = await user("CLINICIAN", "Cara Clinician", clinic.id);
  const staff = await user("STAFF", "Nia Nurse", clinic.id);
  const outsider = await user("CLINICIAN", "Otto Outsider", otherClinic.id);

  const actors = {
    clinician: { id: clinician.id, role: "CLINICIAN", clinicId: clinic.id } satisfies Actor,
    staff: { id: staff.id, role: "STAFF", clinicId: clinic.id } satisfies Actor,
    patient: { id: patient.id, role: "PATIENT", clinicId: clinic.id } satisfies Actor,
    outsider: { id: outsider.id, role: "CLINICIAN", clinicId: otherClinic.id } satisfies Actor,
  };

  const noteA = await createCareEntry(actors.clinician, {
    patientId: patient.id,
    title: "Chest pain review",
    body: NOTE_A_BODY,
    encounterAt: "2026-11-20T09:00:00.000Z",
  });
  await prisma.careEntry.update({ where: { id: noteA.id }, data: { status: "SUBMITTED" } });
  const noteB = await createCareEntry(actors.clinician, {
    patientId: patient.id,
    title: "Draft cardiology thoughts",
    body: NOTE_B_BODY,
    encounterAt: "2026-11-20T12:00:00.000Z",
  });
  const noteC = await createCareEntry(actors.staff, {
    patientId: patient.id,
    title: "Nursing check",
    body: NOTE_C_BODY,
    encounterAt: "2026-11-19T15:00:00.000Z",
  });

  return { clinic, otherClinic, patient, clinician, staff, outsider, actors, noteA, noteB, noteC };
}

export async function deleteAgentFixture(fixture: Awaited<ReturnType<typeof createAgentFixture>>) {
  const userIds = [fixture.patient.id, fixture.clinician.id, fixture.staff.id, fixture.outsider.id];
  const entryIds = (await prisma.careEntry.findMany({ where: { patientId: fixture.patient.id } })).map((e) => e.id);
  await prisma.agentRun.deleteMany({ where: { patientId: fixture.patient.id } });
  await prisma.careAction.deleteMany({ where: { patientId: fixture.patient.id } });
  await prisma.highlightFeedback.deleteMany({ where: { highlight: { careEntryId: { in: entryIds } } } });
  await prisma.highlight.deleteMany({ where: { careEntryId: { in: entryIds } } });
  await prisma.comment.deleteMany({ where: { careEntryId: { in: entryIds } } });
  await prisma.careEntryViewer.deleteMany({ where: { careEntryId: { in: entryIds } } });
  await prisma.entryRevision.deleteMany({ where: { careEntryId: { in: entryIds } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
  await prisma.careEntry.deleteMany({ where: { id: { in: entryIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.clinic.deleteMany({ where: { id: { in: [fixture.clinic.id, fixture.otherClinic.id] } } });
}
