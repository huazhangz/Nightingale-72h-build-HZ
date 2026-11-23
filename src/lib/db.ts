import "server-only";

import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { invalidateGlanceCache } from "./cache/glanceCache";

/**
 * Absolute DATABASE_URL values are honoured (POSIX `file:/...` or Windows `file:D:/...` on any drive;
 * `file:///C:/...` fails to open on Windows). Relative values fall back to prisma/dev.db.
 */
function databaseUrl(): string {
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv && /^file:(?:\/|[A-Za-z]:)/.test(fromEnv)) {
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

/**
 * SQLite tuning, once per process: write-ahead logging lets page reads proceed while the background
 * risk worker writes (the default rollback journal blocks readers), and a busy timeout makes a
 * writer wait for a lock instead of failing with SQLITE_BUSY. journal_mode is persistent in the
 * database file; the pragmas return rows, hence $queryRawUnsafe.
 */
const globalForPragmas = globalThis as unknown as { nightingalePragmas?: Promise<void> };
// Not during `next build`: importing this module while collecting page data must not create or
// open a database file (it would land in the image as an empty prisma/dev.db).
if (process.env.NEXT_PHASE !== "phase-production-build") globalForPragmas.nightingalePragmas ??= (async () => {
  try {
    await basePrisma.$queryRawUnsafe("PRAGMA journal_mode = WAL;");
    await basePrisma.$queryRawUnsafe("PRAGMA busy_timeout = 5000;");
  } catch {
    // Not fatal: the database works in its default journal mode.
  }
})();

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
