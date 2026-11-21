import { prisma } from "../../db";
import { MAX_RISK_ATTEMPTS, runRiskAssessment, type RunRiskOptions } from "./assess";

/**
 * Database-backed work queue for automatic risk assessments.
 *
 * - Note writes enqueue; several writes before the worker runs coalesce into one PENDING row.
 * - The worker runs after the HTTP response (`after()` from next/server), so saving a note never
 *   waits on a model call. A cron-style endpoint can also drain the queue.
 * - Rows stuck in RUNNING (process restarted mid-run) are recovered after STALE_RUNNING_MS.
 *
 * Single-instance deployments are fully covered. With several instances the atomic claim in
 * runRiskAssessment still prevents double work; a dedicated queue would only add throughput.
 */

export const STALE_RUNNING_MS = 10 * 60 * 1000;

export type RiskTrigger = "NOTE_CREATED" | "NOTE_UPDATED" | "NOTE_REVERTED" | "HIGHLIGHT_ADDED" | "MANUAL" | "SEED";

export async function enqueueRiskAssessment(input: {
  patientId: string;
  clinicId: string;
  trigger: RiskTrigger;
  requestedById?: string | null;
}): Promise<string> {
  const pending = await prisma.riskAssessment.findFirst({
    where: { patientId: input.patientId, status: "PENDING" },
    orderBy: { createdAt: "desc" },
  });
  if (pending) {
    if (input.trigger === "MANUAL" && pending.trigger !== "MANUAL") {
      await prisma.riskAssessment.update({ where: { id: pending.id }, data: { trigger: "MANUAL", requestedById: input.requestedById ?? null } });
    }
    return pending.id;
  }
  const created = await prisma.riskAssessment.create({
    data: {
      patientId: input.patientId,
      clinicId: input.clinicId,
      trigger: input.trigger,
      requestedById: input.requestedById ?? null,
    },
  });
  return created.id;
}

export async function recoverStaleAssessments(now = Date.now()): Promise<number> {
  const stale = await prisma.riskAssessment.findMany({
    where: { status: "RUNNING", startedAt: { lt: new Date(now - STALE_RUNNING_MS) } },
    select: { id: true, attempts: true },
  });
  for (const row of stale) {
    await prisma.riskAssessment.update({
      where: { id: row.id },
      data: row.attempts >= MAX_RISK_ATTEMPTS ? { status: "FAILED", error: "Abandoned after restarts" } : { status: "PENDING" },
    });
  }
  return stale.length;
}

/** Process pending assessments, oldest first. Returns how many were run. */
export async function drainRiskQueue(options: RunRiskOptions & { limit?: number } = {}): Promise<number> {
  await recoverStaleAssessments();
  const pending = await prisma.riskAssessment.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: options.limit ?? 10,
    select: { id: true },
  });
  let processed = 0;
  for (const row of pending) {
    if (await runRiskAssessment(row.id, options)) {
      processed += 1;
    }
  }
  return processed;
}

let draining: Promise<number> | null = null;

/** Run the queue after the current response without blocking it. Disabled with NIGHTINGALE_RISK_AUTORUN=off. */
export function scheduleRiskDrain(): void {
  if (process.env.NIGHTINGALE_RISK_AUTORUN === "off") {
    return;
  }
  const task = async () => {
    if (draining) {
      return;
    }
    draining = drainRiskQueue().catch((error) => {
      console.error("[nightingale] risk queue drain failed", error);
      return 0;
    });
    try {
      await draining;
    } finally {
      draining = null;
    }
  };
  import("next/server")
    .then(({ after }) => after(task))
    .catch(() => setTimeout(() => void task(), 0));
}
