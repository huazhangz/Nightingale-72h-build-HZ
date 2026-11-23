import { handlePasswordReset } from "../../../../../../src/lib/api/auth-handlers";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handlePasswordReset(request, id);
}
