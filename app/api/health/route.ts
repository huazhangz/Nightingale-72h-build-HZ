import { handleHealth } from "../../../src/lib/api/health";

export const dynamic = "force-dynamic";

export async function GET() {
  return handleHealth();
}
