import { handleHighlightFeedback } from "../../../../src/lib/api/handlers";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return handleHighlightFeedback(request, id);
}
