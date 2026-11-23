/**
 * Online SQLite backup: a consistent, compacted copy taken with VACUUM INTO while the app runs.
 *
 *   npm run db:backup                       # -> backups/nightingale-<timestamp>.db
 *   npm run db:backup -- --dir /data/backups --keep 14
 *
 * --keep N deletes the oldest backups in the directory beyond the newest N. Restore by stopping the
 * app and copying a backup over the database file named in DATABASE_URL.
 */
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { dir: { type: "string", default: "backups" }, keep: { type: "string" } } });

async function main(): Promise<number> {
  const { prisma } = await import("../src/lib/db");
  const dir = path.resolve(values.dir!);
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `nightingale-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
  if (target.includes("'")) {
    console.error("The backup path must not contain a single quote.");
    return 2;
  }
  await prisma.$executeRawUnsafe(`VACUUM INTO '${target.replace(/\\/g, "/")}'`);
  console.log(`Backup written: ${target} (${Math.round(statSync(target).size / 1024)} KiB)`);
  const keep = values.keep ? Number.parseInt(values.keep, 10) : 0;
  if (keep > 0) {
    const backups = readdirSync(dir)
      .filter((name) => /^nightingale-.*\.db$/.test(name))
      .sort()
      .reverse();
    for (const old of backups.slice(keep)) {
      unlinkSync(path.join(dir, old));
      console.log(`Removed old backup: ${old}`);
    }
  }
  await prisma.$disconnect();
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
