import { handlePatchEntry } from "../../../../src/lib/api/handlers";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return handlePatchEntry(request, id);
}
