import { handleDecideProposal } from "../../../../../src/lib/api/handlers";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleDecideProposal(request, id);
}
