import type { CareEntry, Prisma } from "@prisma/client";
import { prisma } from "../db";
import { syncLocalRiskHighlights } from "./keyword-highlight-sync";

const PHI_METADATA_KEYS = new Set(["userId", "entryId", "newVersion", "targetVersion"]);

export function assertAuditMetadataIsPhiFree(metadata: unknown): void {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("Audit metadata must be a plain object without PHI");
  }
  const record = metadata as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!PHI_METADATA_KEYS.has(key)) {
      throw new Error(`Audit metadata contains unexpected key: ${key}`);
    }
  }
}

function auditMetadata(userId: string, entryId: string, newVersion: number, targetVersion?: number) {
  const metadata: Record<string, string | number> = { userId, entryId, newVersion };
  if (targetVersion !== undefined) {
    metadata.targetVersion = targetVersion;
  }
  assertAuditMetadataIsPhiFree(metadata);
  return metadata;
}

/** Next unused EntryRevision.version for this note (avoids @@unique([careEntryId, version])). */
export async function nextRevisionVersion(
  tx: Prisma.TransactionClient,
  careEntryId: string,
): Promise<number> {
  const latestRevision = await tx.entryRevision.findFirst({
    where: { careEntryId },
    orderBy: { version: "desc" },
  });
  return (latestRevision?.version ?? 0) + 1;
}

export async function updateCareEntry(
  entryId: string,
  newContent: string,
  userId: string,
): Promise<CareEntry> {
  const updated = await prisma.$transaction(async (tx) => {
    const entry = await tx.careEntry.findUniqueOrThrow({ where: { id: entryId } });
    const snapshotVersion = await nextRevisionVersion(tx, entry.id);

    await tx.entryRevision.create({
      data: {
        careEntryId: entry.id,
        editorId: userId,
        version: snapshotVersion,
        body: entry.body,
      },
    });

    const newVersion = Math.max(entry.version + 1, snapshotVersion);
    const next = await tx.careEntry.update({
      where: { id: entryId },
      data: {
        body: newContent,
        version: newVersion,
      },
    });

    await tx.auditLog.create({
      data: {
        actorId: userId,
        action: "NOTE_EDIT",
        entityType: "CareEntry",
        entityId: entryId,
        metadata: auditMetadata(userId, entryId, newVersion),
      },
    });

    return next;
  });
  await syncLocalRiskHighlights(updated.id, updated.body, userId);
  return updated;
}

export async function revertCareEntry(
  entryId: string,
  targetVersion: number,
  userId: string,
): Promise<CareEntry> {
  return prisma.$transaction(async (tx) => {
    const entry = await tx.careEntry.findUniqueOrThrow({ where: { id: entryId } });
    const historical = await tx.entryRevision.findUniqueOrThrow({
      where: {
        careEntryId_version: {
          careEntryId: entryId,
          version: targetVersion,
        },
      },
    });

    const snapshotVersion = await nextRevisionVersion(tx, entry.id);
    await tx.entryRevision.create({
      data: {
        careEntryId: entry.id,
        editorId: userId,
        version: snapshotVersion,
        body: entry.body,
        summary: `snapshot-before-revert-to-v${targetVersion}`,
      },
    });

    const newVersion = Math.max(entry.version + 1, snapshotVersion);
    const updated = await tx.careEntry.update({
      where: { id: entryId },
      data: {
        body: historical.body,
        version: newVersion,
      },
    });

    await tx.auditLog.create({
      data: {
        actorId: userId,
        action: "NOTE_REVERT",
        entityType: "CareEntry",
        entityId: entryId,
        metadata: auditMetadata(userId, entryId, newVersion, targetVersion),
      },
    });

    return updated;
  });
}
