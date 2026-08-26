import type { CareEntry } from "@prisma/client";
import { prisma } from "../db";
import {
  parseProvenancePointer,
  type ProvenancePointer,
} from "./provenance-utils";

export {
  createProvenancePointer,
  parseProvenancePointer,
  type ProvenancePointer,
} from "./provenance-utils";

export type ResolvedProvenance = ProvenancePointer & {
  excerpt: string;
  entry: CareEntry;
};

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
