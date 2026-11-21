import { handleWorklist } from "../../../src/lib/api/handlers";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleWorklist(request);
}
