export type ProvenancePointer = {
  entryId: string;
  startOffset: number;
  endOffset: number;
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
