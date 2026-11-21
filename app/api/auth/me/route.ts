import { handleMe } from "../../../../src/lib/api/auth-handlers";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleMe(request);
}
