import { handleUpdateUser } from "../../../../../src/lib/api/auth-handlers";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleUpdateUser(request, id);
}
