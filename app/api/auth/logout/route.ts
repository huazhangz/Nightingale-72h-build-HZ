import { handleLogout } from "../../../../src/lib/api/handlers";

export async function POST() {
  return handleLogout();
}
