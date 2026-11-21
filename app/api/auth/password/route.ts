import { handleChangePassword } from "../../../../src/lib/api/auth-handlers";

export async function POST(request: Request) {
  return handleChangePassword(request);
}
