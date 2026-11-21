import { handleLogin } from "../../../../src/lib/api/auth-handlers";

export async function POST(request: Request) {
  return handleLogin(request);
}
