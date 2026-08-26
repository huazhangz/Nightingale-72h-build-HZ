import { handlePatchPatientAction } from "../../../../../../src/lib/api/handlers";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; actionId: string }> },
) {
  const { id, actionId } = await context.params;
  return handlePatchPatientAction(request, id, decodeURIComponent(actionId));
}
