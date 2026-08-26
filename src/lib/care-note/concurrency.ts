import type { Actor } from "../auth/rbac";
import { ForbiddenError, assertClinicScope } from "../auth/rbac";
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
  resolution: "applied" | "merged-clinician-precedence";
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

  if (input.baseVersion === entry.version) {
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

  if (input.baseVersion > entry.version) {
    throw new ForbiddenError("baseVersion is ahead of the stored entry");
  }

  const merged = await prisma.$transaction(async (tx) => {
    const latest = await tx.careEntry.findUniqueOrThrow({
      where: { id: input.entryId },
      include: { author: true },
    });

    const baseRevision = await tx.entryRevision.findUnique({
      where: {
        careEntryId_version: {
          careEntryId: input.entryId,
          version: input.baseVersion,
        },
      },
    });

    const baseBody = baseRevision?.body;
    if (baseBody === undefined) {
      throw new Error(`Missing revision snapshot for version ${input.baseVersion}`);
    }

    await tx.entryRevision.create({
      data: {
        careEntryId: latest.id,
        editorId: input.userId,
        version: latest.version,
        body: latest.body,
        summary: "pre-conflict-snapshot",
      },
    });

    const mergedBody = mergeBodies(baseBody, latest.body, input.newContent, actor.role);
    const newVersion = latest.version + 1;
    const updated = await tx.careEntry.update({
      where: { id: latest.id },
      data: {
        body: mergedBody,
        version: newVersion,
        ...(input.title !== undefined ? { title: input.title } : {}),
      },
    });

    await tx.auditLog.create({
      data: {
        actorId: input.userId,
        action: "NOTE_EDIT",
        entityType: "CareEntry",
        entityId: input.entryId,
        metadata: {
          userId: input.userId,
          entryId: input.entryId,
          newVersion,
        },
      },
    });

    return updated;
  });

  return {
    entry: merged,
    conflict: true,
    resolution: "merged-clinician-precedence",
  };
}
