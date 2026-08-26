import { prisma } from "../../src/lib/db";

export async function createNoteFixture(label: string) {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const clinic = await prisma.clinic.create({
    data: {
      name: `Clinic ${suffix}`,
      slug: `clinic-${suffix}`,
    },
  });

  const patient = await prisma.user.create({
    data: {
      email: `patient-${suffix}@nightingale.test`,
      name: "Pat Patient",
      role: "PATIENT",
      passwordHash: "dev-only-not-a-real-hash",
      clinicId: clinic.id,
    },
  });

  const clinician = await prisma.user.create({
    data: {
      email: `clinician-${suffix}@nightingale.test`,
      name: "Casey Clinician",
      role: "CLINICIAN",
      passwordHash: "dev-only-not-a-real-hash",
      clinicId: clinic.id,
    },
  });

  const entry = await prisma.careEntry.create({
    data: {
      clinicId: clinic.id,
      patientId: patient.id,
      authorId: clinician.id,
      title: `Visit ${suffix}`,
      body: "Observed cough and fever. Plan rest and fluids.",
      version: 1,
      encounterAt: new Date("2026-08-26T10:00:00.000Z"),
    },
  });

  return { clinic, patient, clinician, entry };
}

export async function deleteNoteFixture(ids: {
  clinicId: string;
  userIds: string[];
  entryId: string;
}) {
  await prisma.highlight.deleteMany({ where: { careEntryId: ids.entryId } });
  await prisma.comment.deleteMany({ where: { careEntryId: ids.entryId } });
  await prisma.entryRevision.deleteMany({ where: { careEntryId: ids.entryId } });
  await prisma.auditLog.deleteMany({ where: { entityId: ids.entryId } });
  await prisma.careEntry.deleteMany({ where: { id: ids.entryId } });
  await prisma.user.deleteMany({ where: { id: { in: ids.userIds } } });
  await prisma.clinic.deleteMany({ where: { id: ids.clinicId } });
}
