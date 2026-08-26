import { handlePatientSearch } from "../../../../../src/lib/api/handlers";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return handlePatientSearch(request, id);
}
