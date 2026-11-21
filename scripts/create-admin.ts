/**
 * Create (or reset) a clinic administrator from the command line, so no personal account or
 * password ever lives in the seed or the repository.
 *
 *   npm run admin:create -- --email you@example.org --password 'Long-Passphrase-2026' [--name "Your Name"] [--clinic nightingale-demo]
 *
 * Without --password the value is read from NIGHTINGALE_ADMIN_PASSWORD. The password must meet the
 * same policy as sign-up (10+ characters, a letter and a digit, not the email name, not common).
 * Re-running for an existing email resets its password, re-activates it, clears any lockout and
 * signs out its existing sessions.
 */
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    password: { type: "string" },
    name: { type: "string", default: "Clinic Administrator" },
    clinic: { type: "string", default: "nightingale-demo" },
  },
});

async function main(): Promise<number> {
  const { prisma } = await import("../src/lib/db");
  const { hashPassword, passwordIssues } = await import("../src/lib/auth/password");
  const email = values.email?.trim().toLowerCase();
  const password = values.password ?? process.env.NIGHTINGALE_ADMIN_PASSWORD ?? "";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error("Pass --email with a valid address.");
    return 2;
  }
  const issues = passwordIssues(password, { email });
  if (issues.length > 0) {
    console.error(`The password does not meet the policy: ${issues.join(", ")}.`);
    return 2;
  }
  const clinic = await prisma.clinic.findUnique({ where: { slug: values.clinic! } });
  if (!clinic) {
    console.error(`No clinic with slug "${values.clinic}". Run "npx prisma db seed" first, or pass --clinic.`);
    return 2;
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing && (existing.role !== "ADMIN" || existing.clinicId !== clinic.id)) {
    console.error(`${email} already belongs to a ${existing.role} account${existing.clinicId !== clinic.id ? " in another clinic" : ""}; not changed.`);
    return 2;
  }
  const passwordHash = await hashPassword(password);
  const now = new Date();
  const user = existing
    ? await prisma.user.update({
        where: { id: existing.id },
        data: {
          passwordHash,
          name: values.name!,
          status: "ACTIVE",
          failedLoginCount: 0,
          lockedUntil: null,
          passwordChangedAt: now,
          sessionVersion: { increment: 1 },
        },
      })
    : await prisma.user.create({
        data: { email, name: values.name!, role: "ADMIN", clinicId: clinic.id, passwordHash, status: "ACTIVE", passwordChangedAt: now },
      });
  await prisma.auditLog.create({
    data: { actorId: user.id, action: existing ? "ADMIN_RESET_CLI" : "ADMIN_CREATED_CLI", entityType: "User", entityId: user.id, metadata: { via: "scripts/create-admin.ts" } },
  });
  console.log(`${existing ? "Reset" : "Created"} administrator ${email} in ${clinic.name}. Sign in at /login.`);
  await prisma.$disconnect();
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
