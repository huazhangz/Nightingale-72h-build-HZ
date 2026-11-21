import { handleDrainRiskQueue } from "../../../../../src/lib/api/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  return handleDrainRiskQueue(request);
}
