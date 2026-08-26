import "server-only";

import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { invalidateGlanceCache } from "./cache/glanceCache";

/** Windows SQLite URLs must be `file:C:/...` — `file:///C:/...` fails to open. */
function databaseUrl(): string {
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv?.startsWith("file:C:") || fromEnv?.startsWith("file:/")) {
    return fromEnv;
  }
  const dbPath = path.resolve(process.cwd(), "prisma", "dev.db");
  return `file:${dbPath.replace(/\\/g, "/")}`;
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const basePrisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: { db: { url: databaseUrl() } },
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = basePrisma;
}

function invalidatePatientCache(patientId: string | undefined): void {
  if (patientId) {
    invalidateGlanceCache(patientId);
  }
}

async function invalidateByCareEntryId(careEntryId: string | undefined): Promise<void> {
  if (!careEntryId) {
    return;
  }
  const entry = await basePrisma.careEntry.findUnique({
    where: { id: careEntryId },
    select: { patientId: true },
  });
  if (entry) {
    invalidateGlanceCache(entry.patientId);
  }
}

export const prisma = basePrisma.$extends({
  name: "glance-cache-invalidation",
  query: {
    careEntry: {
      async create({ args, query }) {
        const result = await query(args);
        invalidatePatientCache(result.patientId);
        return result;
      },
      async update({ args, query }) {
        const result = await query(args);
        invalidatePatientCache(result.patientId);
        return result;
      },
      async upsert({ args, query }) {
        const result = await query(args);
        invalidatePatientCache(result.patientId);
        return result;
      },
    },
    comment: {
      async create({ args, query }) {
        const result = await query(args);
        await invalidateByCareEntryId(result.careEntryId);
        return result;
      },
      async update({ args, query }) {
        const result = await query(args);
        await invalidateByCareEntryId(result.careEntryId);
        return result;
      },
    },
    highlight: {
      async create({ args, query }) {
        const result = await query(args);
        await invalidateByCareEntryId(result.careEntryId);
        return result;
      },
      async update({ args, query }) {
        const result = await query(args);
        await invalidateByCareEntryId(result.careEntryId);
        return result;
      },
    },
  },
});
