import type { Actor, NoteAuthorRole } from "../auth/rbac";
import { ConflictError } from "../auth/conflict";
import { ForbiddenError, assertCanEditNote, assertClinicScope } from "../auth/rbac";
import { prisma } from "../db";
import { updateCareEntry } from "./revision";

export type ConcurrentEditResult = {
  entry: {
    id: string;
    body: string;
    title: string;
    version: number;
    patientId: string;
    clinicId: string;
  };
  conflict: boolean;
  resolution: "applied";
};

function splitLines(value: string): string[] {
  return value.split("\n");
}

function pickDeterministic(base: string, current: string, incoming: string, clinicianSide: "current" | "incoming"): string {
  if (current === incoming) {
    return current;
  }
  if (current === base) {
    return incoming;
  }
  if (incoming === base) {
    return current;
  }
  return clinicianSide === "incoming" ? incoming : current;
}

/** Line-level 3-way merge. Conflicting hunks always take the clinician side. */
export function mergeBodies(
  base: string,
  current: string,
  incoming: string,
  incomingRole: Actor["role"],
): string {
  const clinicianSide: "current" | "incoming" = incomingRole === "CLINICIAN" ? "incoming" : "current";
  const baseLines = splitLines(base);
  const currentLines = splitLines(current);
  const incomingLines = splitLines(incoming);
  const length = Math.max(baseLines.length, currentLines.length, incomingLines.length);
  const merged: string[] = [];

  for (let index = 0; index < length; index += 1) {
    merged.push(
      pickDeterministic(
        baseLines[index] ?? "",
        currentLines[index] ?? "",
        incomingLines[index] ?? "",
        clinicianSide,
      ),
    );
  }

  return merged.join("\n");
}

async function loadActor(userId: string): Promise<Actor> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return { id: user.id, role: user.role, clinicId: user.clinicId };
}

function assertCanConcurrentEdit(actor: Actor): void {
  if (actor.role !== "STAFF" && actor.role !== "CLINICIAN" && actor.role !== "ADMIN") {
    throw new ForbiddenError(`Role ${actor.role} cannot edit notes`);
  }
}

export async function applyOptimisticEdit(input: {
  entryId: string;
  userId: string;
  newContent: string;
  baseVersion: number;
  title?: string;
}): Promise<ConcurrentEditResult> {
  const actor = await loadActor(input.userId);
  const entry = await prisma.careEntry.findUniqueOrThrow({
    where: { id: input.entryId },
    include: { author: true },
  });

  assertClinicScope(actor, entry.clinicId);
  assertCanConcurrentEdit(actor);
  const authorRole: NoteAuthorRole =
    entry.author.role === "STAFF" || entry.author.role === "CLINICIAN"
      ? entry.author.role
      : "CLINICIAN";
  assertCanEditNote(actor, { authorRole, clinicId: entry.clinicId }, { hasVersionSnapshot: true });

  if (input.baseVersion !== entry.version) {
    throw new ConflictError(
      "This note was updated by someone else. Refresh and review the latest changes before saving.",
      entry.version,
      entry.body,
      entry.title,
    );
  }

  const updated = await updateCareEntry(input.entryId, input.newContent, input.userId);
  if (input.title !== undefined && input.title !== updated.title) {
    const titled = await prisma.careEntry.update({
      where: { id: updated.id },
      data: { title: input.title },
    });
    return {
      entry: titled,
      conflict: false,
      resolution: "applied",
    };
  }
  return {
    entry: updated,
    conflict: false,
    resolution: "applied",
  };
}
