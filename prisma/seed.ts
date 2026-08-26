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
    email: "zhang.wei@nightingale.test",
    name: "张伟 (Zhang Wei)",
    phone: "13812345678",
    dateOfBirth: "1985-06-15",
    title: "Hypertension follow-up",
    body: "Blood pressure remains above target on current therapy. Plan: review home readings and adjust antihypertensives next visit.",
    stage: ConsultationStage.MDT_CONSULTATION,
    status: EntryStatus.SUBMITTED,
  },
  {
    email: "li.na@nightingale.test",
    name: "Li Na",
    phone: "13900000002",
    dateOfBirth: "1978-03-22",
    title: "Diabetes checkup",
    body: "HbA1c improved with diet changes. Plan: continue metformin and repeat labs in 12 weeks.",
    stage: ConsultationStage.CLINICIAN_REVIEWING,
    status: EntryStatus.SUBMITTED,
  },
  {
    email: "wang.fang@nightingale.test",
    name: "Wang Fang",
    phone: "13900000003",
    dateOfBirth: "1969-11-08",
    title: "Post-operative recovery",
    body: "Wound healing well after laparoscopic cholecystectomy. Plan: remove dressing and encourage walking.",
    stage: ConsultationStage.FINAL_SUMMARY,
    status: EntryStatus.LOCKED,
  },
  {
    email: "chen.hao@nightingale.test",
    name: "Chen Hao",
    phone: "13900000004",
    dateOfBirth: "1992-01-19",
    title: "Asthma review",
    body: "Night-time cough reduced on inhaled steroid. Plan: continue preventer and check inhaler technique.",
    stage: ConsultationStage.SUBMITTED,
    status: EntryStatus.DRAFT,
  },
  {
    email: "liu.min@nightingale.test",
    name: "Liu Min",
    phone: "13900000005",
    dateOfBirth: "1996-07-30",
    title: "Antenatal checkup",
    body: "Pregnancy progressing without concerning symptoms. Plan: routine midwife follow-up and iron studies.",
    stage: ConsultationStage.CLINICIAN_REVIEWING,
    status: EntryStatus.SUBMITTED,
  },
  {
    email: "zhao.lei@nightingale.test",
    name: "Zhao Lei",
    phone: "13900000006",
    dateOfBirth: "1958-04-12",
    title: "COPD maintenance",
    body: "Exertional breathlessness stable. Plan: pulmonary rehab referral and inhaler adherence check.",
    stage: ConsultationStage.MDT_CONSULTATION,
    status: EntryStatus.SUBMITTED,
  },
  {
    email: "sun.mei@nightingale.test",
    name: "Sun Mei",
    phone: "13900000007",
    dateOfBirth: "1988-09-05",
    title: "Mood follow-up",
    body: "Sleep and appetite improving with current counselling. Plan: continue weekly sessions and review in a month.",
    stage: ConsultationStage.CLINICIAN_REVIEWING,
    status: EntryStatus.SUBMITTED,
  },
  {
    email: "wu.jun@nightingale.test",
    name: "Wu Jun",
    phone: "13900000008",
    dateOfBirth: "1971-12-02",
    title: "Gout flare review",
    body: "Joint swelling settling on anti-inflammatory cover. Plan: start urate-lowering therapy after the flare.",
    stage: ConsultationStage.SUBMITTED,
    status: EntryStatus.DRAFT,
  },
  {
    email: "zhou.yan@nightingale.test",
    name: "Zhou Yan",
    phone: "13900000009",
    dateOfBirth: "1982-02-14",
    title: "Thyroid monitoring",
    body: "TSH within range on current levothyroxine dose. Plan: repeat thyroid function in six months.",
    stage: ConsultationStage.FINAL_SUMMARY,
    status: EntryStatus.LOCKED,
  },
  {
    email: "huang.tao@nightingale.test",
    name: "Huang Tao",
    phone: "13900000010",
    dateOfBirth: "1964-08-21",
    title: "Knee osteoarthritis",
    body: "Pain limits stairs; no red-flag swelling. Plan: physiotherapy and topical anti-inflammatory gel.",
    stage: ConsultationStage.CLINICIAN_REVIEWING,
    status: EntryStatus.SUBMITTED,
  },
  {
    email: "lin.xia@nightingale.test",
    name: "Lin Xia",
    phone: "13900000011",
    dateOfBirth: "1955-05-09",
    title: "Chronic kidney review",
    body: "eGFR stable; potassium within limits. Plan: medication review with the renal nurse.",
    stage: ConsultationStage.MDT_CONSULTATION,
    status: EntryStatus.SUBMITTED,
  },
  {
    email: "gao.peng@nightingale.test",
    name: "Gao Peng",
    phone: "13900000012",
    dateOfBirth: "1990-10-18",
    title: "Migraine clinic",
    body: "Fewer attacks after trigger diary. Plan: continue preventer and acute triptan as needed.",
    stage: ConsultationStage.SUBMITTED,
    status: EntryStatus.DRAFT,
  },
  {
    email: "xu.ting@nightingale.test",
    name: "Xu Ting",
    phone: "13900000013",
    dateOfBirth: "1999-06-03",
    title: "Iron deficiency follow-up",
    body: "Ferritin rising on oral iron. Plan: continue tablets and recheck blood count.",
    stage: ConsultationStage.CLINICIAN_REVIEWING,
    status: EntryStatus.SUBMITTED,
  },
  {
    email: "ma.qiang@nightingale.test",
    name: "Ma Qiang",
    phone: "13900000014",
    dateOfBirth: "1975-01-27",
    title: "Lipid clinic",
    body: "LDL remains above target. Plan: intensify statin and diet counselling.",
    stage: ConsultationStage.FINAL_SUMMARY,
    status: EntryStatus.LOCKED,
  },
  {
    email: "he.jing@nightingale.test",
    name: "He Jing",
    phone: "13900000015",
    dateOfBirth: "1986-12-11",
    title: "Urinary infection follow-up",
    body: "Symptoms resolved after antibiotics. Plan: no further treatment if urine stays clear.",
    stage: ConsultationStage.SUBMITTED,
    status: EntryStatus.DRAFT,
  },
];

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
      name: "Sam Staff",
      role: Role.STAFF,
      clinicId: clinic.id,
      employeeCode: "000001",
      title: "Registered Nurse",
      department: "Outpatient Nursing",
      passwordHash: DEV_PASSWORD_HASH,
    },
    create: {
      email: "staff@nightingale.test",
      name: "Sam Staff",
      role: Role.STAFF,
      clinicId: clinic.id,
      employeeCode: "000001",
      title: "Registered Nurse",
      department: "Outpatient Nursing",
      passwordHash: DEV_PASSWORD_HASH,
    },
  });

  const clinician = await prisma.user.upsert({
    where: { email: "clinician@nightingale.test" },
    update: {
      name: "Casey Clinician",
      role: Role.CLINICIAN,
      clinicId: clinic.id,
      employeeCode: "000002",
      title: "Attending Physician",
      department: "Internal Medicine",
      passwordHash: DEV_PASSWORD_HASH,
    },
    create: {
      email: "clinician@nightingale.test",
      name: "Casey Clinician",
      role: Role.CLINICIAN,
      clinicId: clinic.id,
      employeeCode: "000002",
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
      const excerpt = "Blood pressure remains above target";
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
  console.log("Staff code 000001, clinician code 000002");
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
