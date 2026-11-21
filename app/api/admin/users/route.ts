import { handleInviteUser, handleListUsers } from "../../../../src/lib/api/auth-handlers";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleListUsers(request);
}

export async function POST(request: Request) {
  return handleInviteUser(request);
}
