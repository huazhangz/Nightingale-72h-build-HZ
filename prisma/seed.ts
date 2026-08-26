import path from "node:path";
import { ConsultationStage, EntryStatus, PrismaClient, Role } from "@prisma/client";

const dbPath = path.resolve(process.cwd(), "prisma", "dev.db");
process.env.DATABASE_URL = `file:${dbPath.replace(/\\/g, "/")}`;

const prisma = new PrismaClient();
const DEV_PASSWORD_HASH = "dev-only-not-a-real-hash";

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
    body: "Your blood pressure review is underway.\nClinician: systolic remains above target on current therapy.\nPlan: review home readings and adjust antihypertensives next visit.",
    stage: ConsultationStage.MDT_CONSULTATION,
    status: EntryStatus.SUBMITTED,
  },
  {
    email: "james.okonkwo@nightingale.test",
    name: "James Okonkwo",
    phone: "5550101002",
    dateOfBirth: "1976-11-04",
    title: "Diabetes checkup",
    body: "Your diabetes visit summary is ready for you.\nClinician: HbA1c improved with diet changes.\nPlan: continue metformin and repeat labs in 12 weeks.",
    stage: ConsultationStage.CLINICIAN_REVIEWING,
    status: EntryStatus.SUBMITTED,
  },
  {
    email: "sofia.alvarez@nightingale.test",
    name: "Sofia Alvarez",
    phone: "5550101003",
    dateOfBirth: "1991-07-19",
    title: "Post-operative recovery",
    body: "Your recovery plan after surgery is on track.\nClinician: wound healing well after laparoscopic cholecystectomy.\nPlan: remove dressing and encourage walking.",
    stage: ConsultationStage.FINAL_SUMMARY,
    status: EntryStatus.LOCKED,
  },
  {
    email: "lars.johansson@nightingale.test",
    name: "Lars Johansson",
    phone: "5550101004",
    dateOfBirth: "1968-02-28",
    title: "Asthma review",
    body: "Your breathing review is complete.\nClinician: night-time cough reduced on inhaled steroid.\nPlan: continue preventer and check inhaler technique.",
    stage: ConsultationStage.SUBMITTED,
    status: EntryStatus.DRAFT,
  },
  {
    email: "amara.diallo@nightingale.test",
    name: "Amara Diallo",
    phone: "5550101005",
    dateOfBirth: "1989-09-08",
    title: "Antenatal checkup",
    body: "Your pregnancy checkup is progressing well.\nClinician: no concerning symptoms reported.\nPlan: routine midwife follow-up and iron studies.",
    stage: ConsultationStage.CLINICIAN_REVIEWING,
    status: EntryStatus.SUBMITTED,
  },
  {
    email: "noah.williams@nightingale.test",
    name: "Noah Williams",
    phone: "5550101006",
    dateOfBirth: "1959-05-21",
    title: "COPD maintenance",
    body: "Your lung clinic visit has been recorded.\nClinician: exertional breathlessness is stable.\nPlan: pulmonary rehab referral and inhaler adherence check.",
    stage: ConsultationStage.MDT_CONSULTATION,
    status: EntryStatus.SUBMITTED,
  },
  {
    email: "pierre.dubois@nightingale.test",
    name: "Pierre Dubois",
    phone: "5550101007",
    dateOfBirth: "1973-12-15",
    title: "Mood follow-up",
    body: "Your wellbeing follow-up is scheduled.\nClinician: sleep and appetite improving with counselling.\nPlan: continue weekly sessions and review in a month.",
    stage: ConsultationStage.CLINICIAN_REVIEWING,
    status: EntryStatus.SUBMITTED,
  },
  {
    email: "aisha.mensah@nightingale.test",
    name: "Aisha Mensah",
    phone: "5550101008",
    dateOfBirth: "1987-01-03",
    title: "Gout flare review",
    body: "Your joint pain review is in progress.\nClinician: swelling settling on anti-inflammatory cover.\nPlan: start urate-lowering therapy after the flare.",
    stage: ConsultationStage.SUBMITTED,
    status: EntryStatus.DRAFT,
  },
  {
    email: "mateo.silva@nightingale.test",
    name: "Mateo Silva",
    phone: "5550101009",
    dateOfBirth: "1980-08-17",
    title: "Thyroid monitoring",
    body: "Your thyroid results have been reviewed.\nClinician: TSH within range on current levothyroxine dose.\nPlan: repeat thyroid function in six months.",
    stage: ConsultationStage.FINAL_SUMMARY,
    status: EntryStatus.LOCKED,
  },
  {
    email: "hannah.berg@nightingale.test",
    name: "Hannah Berg",
    phone: "5550101010",
    dateOfBirth: "1995-04-26",
    title: "Knee osteoarthritis",
    body: "Your joint clinic visit is complete.\nClinician: pain limits stairs; no red-flag swelling.\nPlan: physiotherapy and topical anti-inflammatory gel.",
    stage: ConsultationStage.CLINICIAN_REVIEWING,
    status: EntryStatus.SUBMITTED,
  },
];

async function deletePatientRecord(patientId: string): Promise<void> {
  const entries = await prisma.careEntry.findMany({
    where: { patientId },
    select: { id: true },
  });
  const entryIds = entries.map((entry) => entry.id);
  if (entryIds.length > 0) {
    await prisma.highlightFeedback.deleteMany({
      where: { highlight: { careEntryId: { in: entryIds } } },
    });
    await prisma.highlight.deleteMany({ where: { careEntryId: { in: entryIds } } });
    await prisma.comment.deleteMany({ where: { careEntryId: { in: entryIds } } });
    await prisma.entryRevision.deleteMany({ where: { careEntryId: { in: entryIds } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: entryIds } } });
    await prisma.careEntry.deleteMany({ where: { id: { in: entryIds } } });
  }
  await prisma.user.delete({ where: { id: patientId } });
}

async function main() {
  const clinic = await prisma.clinic.upsert({
    where: { slug: "nightingale-demo" },
    update: { name: "Nightingale Demo Clinic" },
    create: {
      name: "Nightingale Demo Clinic",
      slug: "nightingale-demo",
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
      passwordHash: DEV_PASSWORD_HASH,
    },
    create: {
      email: "staff@nightingale.test",
      name: "Museil Kamil",
      role: Role.STAFF,
      clinicId: clinic.id,
      employeeCode: "00001",
      title: "Registered Nurse",
      department: "Outpatient Nursing",
      passwordHash: DEV_PASSWORD_HASH,
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
      passwordHash: DEV_PASSWORD_HASH,
    },
    create: {
      email: "clinician@nightingale.test",
      name: "Joe Zhou",
      role: Role.CLINICIAN,
      clinicId: clinic.id,
      employeeCode: "00002",
      title: "Attending Physician",
      department: "Internal Medicine",
      passwordHash: DEV_PASSWORD_HASH,
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
      passwordHash: DEV_PASSWORD_HASH,
    },
    create: {
      email: "admin@nightingale.test",
      name: "Avery Admin",
      role: Role.ADMIN,
      clinicId: clinic.id,
      employeeCode: "000003",
      title: "Clinic Administrator",
      department: "Operations",
      passwordHash: DEV_PASSWORD_HASH,
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
        passwordHash: DEV_PASSWORD_HASH,
      },
      create: {
        email: patient.email,
        name: patient.name,
        role: Role.PATIENT,
        clinicId: clinic.id,
        phone: patient.phone,
        dateOfBirth: patient.dateOfBirth,
        passwordHash: DEV_PASSWORD_HASH,
      },
    });
    if (index === 0) {
      featuredId = user.id;
    }

    const existing = await prisma.careEntry.findFirst({
      where: { patientId: user.id, title: patient.title },
    });
    if (existing) {
      await prisma.careEntry.update({
        where: { id: existing.id },
        data: { consultationStage: patient.stage, status: patient.status, body: patient.body },
      });
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

  console.log("Seeded clinic:", clinic.slug);
  console.log("Seeded patients:", PATIENTS.length, "featured:", featuredId, PATIENTS[0]?.email);
  console.log("Staff code 00001 / secret 00001, clinician code 00002 / secret 00002");
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
