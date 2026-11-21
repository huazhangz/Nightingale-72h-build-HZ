import { handleDemoAccounts } from "../../../../src/lib/api/auth-handlers";

export const dynamic = "force-dynamic";

export async function GET() {
  return handleDemoAccounts();
}
