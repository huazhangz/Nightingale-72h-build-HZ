import { handleReissueInvitation } from "../../../../../../src/lib/api/auth-handlers";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleReissueInvitation(request, id);
}
