import { handleRegister } from "../../../../src/lib/api/auth-handlers";

export async function POST(request: Request) {
  return handleRegister(request);
}
