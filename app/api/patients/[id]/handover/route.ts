import { handleLatestHandover, handleRunHandover } from "../../../../../src/lib/api/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Agent runs take tens of seconds; allow up to the agent's own deadline on hosts that honour this. */
export const maxDuration = 300;

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleLatestHandover(request, id);
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleRunHandover(request, id);
}
