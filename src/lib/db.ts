import path from "node:path";
import { PrismaClient } from "@prisma/client";

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

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: { db: { url: databaseUrl() } },
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
