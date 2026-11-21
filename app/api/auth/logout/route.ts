import { handleLogout } from "../../../../src/lib/api/auth-handlers";

export async function POST() {
  return handleLogout();
}
