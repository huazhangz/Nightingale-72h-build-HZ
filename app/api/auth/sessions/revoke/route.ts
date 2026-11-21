import { handleSignOutEverywhere } from "../../../../../src/lib/api/auth-handlers";

export async function POST(request: Request) {
  return handleSignOutEverywhere(request);
}
