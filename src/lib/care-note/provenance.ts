import type { CareEntry } from "@prisma/client";
import { prisma } from "../db";

export type ProvenancePointer = {
  entryId: string;
  startOffset: number;
  endOffset: number;
};

export type ResolvedProvenance = ProvenancePointer & {
  excerpt: string;
  entry: CareEntry;
};

const POINTER_PATTERN = /^([^#]+)#(\d+)-(\d+)$/;

export function createProvenancePointer(
  entryId: string,
  startOffset: number,
  endOffset: number,
): string {
  if (!entryId) {
    throw new Error("entryId is required");
  }
  if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset)) {
    throw new Error("Offsets must be integers");
  }
  if (startOffset < 0 || endOffset < startOffset) {
    throw new Error("Invalid provenance offsets");
  }
  return `${entryId}#${startOffset}-${endOffset}`;
}

export function parseProvenancePointer(pointerString: string): ProvenancePointer {
  const match = POINTER_PATTERN.exec(pointerString);
  if (!match) {
    throw new Error(`Invalid provenance pointer: ${pointerString}`);
  }
  return {
    entryId: match[1],
    startOffset: Number(match[2]),
    endOffset: Number(match[3]),
  };
}

export async function resolveProvenancePointer(pointerString: string): Promise<ResolvedProvenance> {
  const pointer = parseProvenancePointer(pointerString);
  const entry = await prisma.careEntry.findUniqueOrThrow({
    where: { id: pointer.entryId },
  });

  if (pointer.endOffset > entry.body.length) {
    throw new Error("Provenance pointer is out of range for current entry body");
  }

  const excerpt = entry.body.slice(pointer.startOffset, pointer.endOffset);
  if (excerpt.length !== pointer.endOffset - pointer.startOffset) {
    throw new Error("Provenance pointer does not resolve to a valid substring");
  }

  return {
    ...pointer,
    excerpt,
    entry,
  };
}
