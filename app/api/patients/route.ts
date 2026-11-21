import { handleCreatePatient } from "../../../src/lib/api/auth-handlers";
import { handleWorklist } from "../../../src/lib/api/handlers";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleWorklist(request);
}

export async function POST(request: Request) {
  return handleCreatePatient(request);
}
