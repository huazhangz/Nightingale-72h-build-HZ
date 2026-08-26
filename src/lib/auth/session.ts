import { prisma } from "../db";
import { ForbiddenError, type Actor } from "./rbac";
import { ConflictError } from "./conflict";

export class UnauthorizedError extends Error {
  readonly code = "UNAUTHORIZED" as const;

  constructor(message = "Authentication required") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export async function requireActor(request: Request): Promise<Actor> {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    throw new UnauthorizedError();
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new UnauthorizedError("Unknown user");
  }
  return { id: user.id, role: user.role, clinicId: user.clinicId };
}

export function errorResponse(error: unknown): Response {
  if (error instanceof UnauthorizedError) {
    return Response.json({ error: error.message, code: error.code }, { status: 401 });
  }
  if (error instanceof ForbiddenError) {
    return Response.json({ error: error.message, code: error.code }, { status: 403 });
  }
  if (error instanceof ConflictError) {
    return Response.json(
      {
        error: error.message,
        code: error.code,
        currentVersion: error.currentVersion,
        currentBody: error.currentBody,
        currentTitle: error.currentTitle,
      },
      { status: 409 },
    );
  }
  if (error instanceof Error && /No .* found/.test(error.message)) {
    return Response.json({ error: error.message }, { status: 404 });
  }
  const message = error instanceof Error ? error.message : "Internal error";
  return Response.json({ error: message }, { status: 500 });
}
