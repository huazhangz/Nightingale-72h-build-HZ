import path from "node:path";
import { ConsultationStage, EntryStatus, PrismaClient, Role, UserStatus } from "@prisma/client";
import { hashPassword } from "../src/lib/auth/password";
import { DEMO_ENROLLMENT_CODE, DEMO_PASSWORD } from "../src/lib/auth/demo";
import { ENGINE_LABELS, engineConfidence, findLocalRiskPhrases } from "../src/lib/care-note/keyword-highlights";
import { createProvenancePointer } from "../src/lib/care-note/provenance-utils";
import { SEEDED_NOTES, wordCount } from "./clinical-notes";

// Same rule as the app (src/lib/db.ts): an absolute DATABASE_URL (e.g. file:/data/nightingale.db in
// the container) is used as is; otherwise the local development database prisma/dev.db.
if (!/^file:(?:\/|[A-Za-z]:)/.test(process.env.DATABASE_URL ?? "")) {
  const dbPath = path.resolve(process.cwd(), "prisma", "dev.db");
  process.env.DATABASE_URL = `file:${dbPath.replace(/\\/g, "/")}`;
}

const prisma = new PrismaClient();

type PatientSeed = {
  email: string;
  name: string;
  phone: string;
  dateOfBirth: string;
  title: string;
  body: string;
  stage: ConsultationStage;
  status: EntryStatus;
};

const PATIENTS: PatientSeed[] = [
  {
    email: "elena.rossi@nightingale.test",
    name: "Elena Rossi",
    phone: "5550101001",
    dateOfBirth: "1984-03-12",
    title: "Blood pressure follow-up",
    body: SEEDED_NOTES["elena.rossi@nightingale.test"]!,
    stage: ConsultationStage.MDT_CONSULTATION,
    status: EntryStatus.SUBMITTED,
  },
  {
    email: "james.okonkwo@nightingale.test",
    name: "James Okonkwo",
    phone: "5550101002",
    dateOfBirth: "1976-11-04",
    title: "Diabetes checkup",
    body: SEEDED_NOTES["james.okonkwo@nightingale.test"]!,
    stage: ConsultationStage.CLINICIAN_REVIEWING,
    status: EntryStatus.SUBMITTED,
  },
  {
    email: "sofia.alvarez@nightingale.test",
    name: "Sofia Alvarez",
    phone: "5550101003",
    dateOfBirth: "1991-07-19",
    title: "Post-operative recovery",
    body: SEEDED_NOTES["sofia.alvarez@nightingale.test"]!,
    stage: ConsultationStage.FINAL_SUMMARY,
    status: EntryStatus.LOCKED,
  },
  {
    email: "lars.johansson@nightingale.test",
    name: "Lars Johansson",
    phone: "5550101004",
    dateOfBirth: "1968-02-28",
    title: "Asthma review",
    body: SEEDED_NOTES["lars.johansson@nightingale.test"]!,
    stage: ConsultationStage.SUBMITTED,
    status: EntryStatus.DRAFT,
  },
  {
    email: "amara.diallo@nightingale.test",
    name: "Amara Diallo",
    phone: "5550101005",
    dateOfBirth: "1989-09-08",
    title: "Antenatal checkup",
    body: SEEDED_NOTES["amara.diallo@nightingale.test"]!,
    stage: ConsultationStage.CLINICIAN_REVIEWING,
    status: EntryStatus.SUBMITTED,
  },
  {
    email: "noah.williams@nightingale.test",
    name: "Noah Williams",
    phone: "5550101006",
    dateOfBirth: "1959-05-21",
    title: "COPD maintenance",
    body: SEEDED_NOTES["noah.williams@nightingale.test"]!,
    stage: ConsultationStage.MDT_CONSULTATION,
    status: EntryStatus.SUBMITTED,
  },
  {
    email: "pierre.dubois@nightingale.test",
    name: "Pierre Dubois",
    phone: "5550101007",
    dateOfBirth: "1973-12-15",
    title: "Mood follow-up",
    body: SEEDED_NOTES["pierre.dubois@nightingale.test"]!,
    stage: ConsultationStage.CLINICIAN_REVIEWING,
    status: EntryStatus.SUBMITTED,
  },
  {
    email: "aisha.mensah@nightingale.test",
    name: "Aisha Mensah",
    phone: "5550101008",
    dateOfBirth: "1987-01-03",
    title: "Gout flare review",
    body: SEEDED_NOTES["aisha.mensah@nightingale.test"]!,
    stage: ConsultationStage.SUBMITTED,
    status: EntryStatus.DRAFT,
  },
  {
    email: "mateo.silva@nightingale.test",
    name: "Mateo Silva",
    phone: "5550101009",
    dateOfBirth: "1980-08-17",
    title: "Thyroid monitoring",
    body: SEEDED_NOTES["mateo.silva@nightingale.test"]!,
    stage: ConsultationStage.FINAL_SUMMARY,
    status: EntryStatus.LOCKED,
  },
  {
    email: "hannah.berg@nightingale.test",
    name: "Hannah Berg",
    phone: "5550101010",
    dateOfBirth: "1995-04-26",
    title: "Knee osteoarthritis",
    body: SEEDED_NOTES["hannah.berg@nightingale.test"]!,
    stage: ConsultationStage.CLINICIAN_REVIEWING,
    status: EntryStatus.SUBMITTED,
  },
];

async function deleteCareEntryRows(entryIds: string[]): Promise<void> {
  if (entryIds.length === 0) {
    return;
  }
  await prisma.highlightFeedback.deleteMany({
    where: { highlight: { careEntryId: { in: entryIds } } },
  });
  await prisma.highlight.deleteMany({ where: { careEntryId: { in: entryIds } } });
    await prisma.comment.deleteMany({ where: { careEntryId: { in: entryIds } } });
    await prisma.careEntryViewer.deleteMany({ where: { careEntryId: { in: entryIds } } });
  await prisma.entryRevision.deleteMany({ where: { careEntryId: { in: entryIds } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: entryIds } } });
  await prisma.careEntry.deleteMany({ where: { id: { in: entryIds } } });
}

async function deletePatientRecord(patientId: string): Promise<void> {
  const entries = await prisma.careEntry.findMany({
    where: { patientId },
    select: { id: true },
  });
  await deleteCareEntryRows(entries.map((entry) => entry.id));
  await prisma.user.delete({ where: { id: patientId } });
}

async function writeKeywordHighlights(careEntryId: string, body: string, createdById: string): Promise<void> {
  await prisma.highlight.deleteMany({
    where: {
      careEntryId,
      source: "MODEL",
      label: { in: [...ENGINE_LABELS] },
    },
  });
  const hits = findLocalRiskPhrases(body);
  if (hits.length === 0) {
    return;
  }
  await prisma.highlight.createMany({
    data: hits.map((hit) => ({
      careEntryId,
      createdById,
      startOffset: hit.startOffset,
      endOffset: hit.endOffset,
      excerpt: hit.excerpt,
      label: hit.label,
      source: "MODEL" as const,
      confidence: engineConfidence(hit.label),
      provenancePointer: createProvenancePointer(careEntryId, hit.startOffset, hit.endOffset),
    })),
  });
}

async function main() {
  for (const patient of PATIENTS) {
    const words = wordCount(patient.body);
    if (words < 200) {
      throw new Error(`Seed note for ${patient.email} has only ${words} words`);
    }
  }

  const clinic = await prisma.clinic.upsert({
    where: { slug: "nightingale-demo" },
    update: { name: "Nightingale Demo Clinic", enrollmentCode: DEMO_ENROLLMENT_CODE },
    create: {
      name: "Nightingale Demo Clinic",
      slug: "nightingale-demo",
      enrollmentCode: DEMO_ENROLLMENT_CODE,
    },
  });

  const staff = await prisma.user.upsert({
    where: { email: "staff@nightingale.test" },
    update: {
      name: "Museil Kamil",
      role: Role.STAFF,
      clinicId: clinic.id,
      employeeCode: "00001",
      title: "Registered Nurse",
      department: "Outpatient Nursing",
      passwordHash: await hashPassword(DEMO_PASSWORD),
      status: UserStatus.ACTIVE,
      failedLoginCount: 0,
      lockedUntil: null,
    },
    create: {
      email: "staff@nightingale.test",
      name: "Museil Kamil",
      role: Role.STAFF,
      clinicId: clinic.id,
      employeeCode: "00001",
      title: "Registered Nurse",
      department: "Outpatient Nursing",
      passwordHash: await hashPassword(DEMO_PASSWORD),
      status: UserStatus.ACTIVE,
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });

  const clinician = await prisma.user.upsert({
    where: { email: "clinician@nightingale.test" },
    update: {
      name: "Joe Zhou",
      role: Role.CLINICIAN,
      clinicId: clinic.id,
      employeeCode: "00002",
      title: "Attending Physician",
      department: "Internal Medicine",
      passwordHash: await hashPassword(DEMO_PASSWORD),
      status: UserStatus.ACTIVE,
      failedLoginCount: 0,
      lockedUntil: null,
    },
    create: {
      email: "clinician@nightingale.test",
      name: "Joe Zhou",
      role: Role.CLINICIAN,
      clinicId: clinic.id,
      employeeCode: "00002",
      title: "Attending Physician",
      department: "Internal Medicine",
      passwordHash: await hashPassword(DEMO_PASSWORD),
      status: UserStatus.ACTIVE,
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });

  await prisma.user.upsert({
    where: { email: "admin@nightingale.test" },
    update: {
      name: "Avery Admin",
      role: Role.ADMIN,
      clinicId: clinic.id,
      employeeCode: "000003",
      title: "Clinic Administrator",
      department: "Operations",
      passwordHash: await hashPassword(DEMO_PASSWORD),
      status: UserStatus.ACTIVE,
      failedLoginCount: 0,
      lockedUntil: null,
    },
    create: {
      email: "admin@nightingale.test",
      name: "Avery Admin",
      role: Role.ADMIN,
      clinicId: clinic.id,
      employeeCode: "000003",
      title: "Clinic Administrator",
      department: "Operations",
      passwordHash: await hashPassword(DEMO_PASSWORD),
      status: UserStatus.ACTIVE,
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });

  const keepEmails = PATIENTS.map((patient) => patient.email);
  const stalePatients = await prisma.user.findMany({
    where: { clinicId: clinic.id, role: Role.PATIENT, email: { notIn: keepEmails } },
    select: { id: true },
  });
  for (const stale of stalePatients) {
    await deletePatientRecord(stale.id);
  }

  let featuredId = "";
  for (const [index, patient] of PATIENTS.entries()) {
    const user = await prisma.user.upsert({
      where: { email: patient.email },
      update: {
        name: patient.name,
        role: Role.PATIENT,
        clinicId: clinic.id,
        phone: patient.phone,
        dateOfBirth: patient.dateOfBirth,
        passwordHash: await hashPassword(DEMO_PASSWORD),
      status: UserStatus.ACTIVE,
      failedLoginCount: 0,
      lockedUntil: null,
      },
      create: {
        email: patient.email,
        name: patient.name,
        role: Role.PATIENT,
        clinicId: clinic.id,
        phone: patient.phone,
        dateOfBirth: patient.dateOfBirth,
        passwordHash: await hashPassword(DEMO_PASSWORD),
      status: UserStatus.ACTIVE,
      failedLoginCount: 0,
      lockedUntil: null,
      },
    });
    if (index === 0) {
      featuredId = user.id;
    }

    const extras = await prisma.careEntry.findMany({
      where: { patientId: user.id, NOT: { title: patient.title } },
      select: { id: true },
    });
    await deleteCareEntryRows(extras.map((entry) => entry.id));

    const existing = await prisma.careEntry.findFirst({
      where: { patientId: user.id, title: patient.title },
    });
    if (existing) {
      await prisma.careEntry.update({
        where: { id: existing.id },
        data: { consultationStage: patient.stage, status: patient.status, body: patient.body },
      });
      await writeKeywordHighlights(existing.id, patient.body, existing.authorId);
      continue;
    }

    const authorId = index % 3 === 0 ? staff.id : clinician.id;
    const entry = await prisma.careEntry.create({
      data: {
        clinicId: clinic.id,
        patientId: user.id,
        authorId,
        title: patient.title,
        body: patient.body,
        version: 1,
        status: patient.status,
        consultationStage: patient.stage,
        encounterAt: new Date(Date.UTC(2026, 7, 1 + index, 10, 0, 0)),
        revisions: {
          create: {
            editorId: authorId,
            version: 1,
            body: patient.body,
            summary: "Initial encounter note",
          },
        },
      },
    });

    if (index === 0) {
      const excerpt = "systolic remains above target";
      await prisma.comment.create({
        data: {
          careEntryId: entry.id,
          authorId: staff.id,
          body: "Nursing staff: home BP log collected. Plan: flag if systolic stays high.",
        },
      });
      await prisma.highlight.create({
        data: {
          careEntryId: entry.id,
          createdById: clinician.id,
          startOffset: patient.body.indexOf(excerpt),
          endOffset: patient.body.indexOf(excerpt) + excerpt.length,
          excerpt,
          label: "risk",
          source: "MODEL",
          confidence: 0.9,
          provenancePointer: `${entry.id}#${patient.body.indexOf(excerpt)}-${patient.body.indexOf(excerpt) + excerpt.length}`,
        },
      });
    }

    await writeKeywordHighlights(entry.id, patient.body, authorId);

    await prisma.auditLog.create({
      data: {
        actorId: authorId,
        action: "NOTE_CREATE",
        entityType: "CareEntry",
        entityId: entry.id,
        metadata: { userId: authorId, entryId: entry.id, newVersion: 1 },
      },
    });
  }

  await prisma.featureWeight.upsert({
    where: { featureKey: "highlight.confidence" },
    update: { weight: 1.0 },
    create: {
      featureKey: "highlight.confidence",
      weight: 1.0,
      description: "Default ranking weight for model highlight confidence",
    },
  });

  // Initial risk triage for every patient, rule-based so seeding needs no API key. With a key
  // configured, the first note edit (or "Reassess") produces an agent assessment.
  const { drainRiskQueue, enqueueRiskAssessment } = await import("../src/lib/agent/risk/queue");
  const seededPatients = await prisma.user.findMany({ where: { clinicId: clinic.id, role: Role.PATIENT }, select: { id: true } });
  for (const patient of seededPatients) {
    await enqueueRiskAssessment({ patientId: patient.id, clinicId: clinic.id, trigger: "SEED" });
  }
  const assessed = await drainRiskQueue({ rulesOnly: true, limit: 100 });

  console.log("Seeded clinic:", clinic.slug, "enrollment code:", DEMO_ENROLLMENT_CODE);
  console.log("Seeded patients:", PATIENTS.length, "featured:", featuredId, PATIENTS[0]?.email);
  console.log("Risk assessments (rule-based):", assessed);
  console.log(`Demo sign-in: clinician@ / staff@ / admin@nightingale.test, password ${DEMO_PASSWORD}`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
