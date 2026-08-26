import { PrismaClient, Role } from "@prisma/client";

const prisma = new PrismaClient();

const DEV_PASSWORD_HASH = "dev-only-not-a-real-hash";

async function main() {
  const clinic = await prisma.clinic.upsert({
    where: { slug: "nightingale-demo" },
    update: { name: "Nightingale Demo Clinic" },
    create: {
      name: "Nightingale Demo Clinic",
      slug: "nightingale-demo",
    },
  });

  const users: Array<{ email: string; name: string; role: Role }> = [
    { email: "patient@nightingale.test", name: "Pat Patient", role: Role.PATIENT },
    { email: "staff@nightingale.test", name: "Sam Staff", role: Role.STAFF },
    { email: "clinician@nightingale.test", name: "Casey Clinician", role: Role.CLINICIAN },
    { email: "admin@nightingale.test", name: "Avery Admin", role: Role.ADMIN },
  ];

  for (const user of users) {
    await prisma.user.upsert({
      where: { email: user.email },
      update: {
        name: user.name,
        role: user.role,
        clinicId: clinic.id,
        passwordHash: DEV_PASSWORD_HASH,
      },
      create: {
        email: user.email,
        name: user.name,
        role: user.role,
        clinicId: clinic.id,
        passwordHash: DEV_PASSWORD_HASH,
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
  console.log(
    "Seeded users:",
    users.map((user) => `${user.role} <${user.email}>`).join(", "),
  );
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
