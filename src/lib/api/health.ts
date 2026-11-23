import { prisma } from "../db";

const startedAt = Date.now();

/**
 * Liveness and readiness for load balancers and container orchestrators. Public on purpose (no
 * session), so it returns operational counters only: no names, no record content, no identifiers.
 * 200 when the database answers, 503 otherwise.
 */
export async function handleHealth(): Promise<Response> {
  try {
    await prisma.$queryRawUnsafe("SELECT 1");
    const [queued, failedLastDay] = await Promise.all([
      prisma.riskAssessment.count({ where: { status: { in: ["PENDING", "RUNNING"] } } }),
      prisma.riskAssessment.count({ where: { status: "FAILED", createdAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) } } }),
    ]);
    return Response.json(
      { status: "ok", database: "ok", riskQueue: { queued, failedLastDay }, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json({ status: "error", database: "unreachable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
