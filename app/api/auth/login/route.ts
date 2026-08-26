import { handleLogin } from "../../../../src/lib/api/handlers";

export async function POST(request: Request) {
  return handleLogin(request);
}
