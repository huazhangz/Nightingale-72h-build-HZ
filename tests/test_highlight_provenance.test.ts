import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createProvenancePointer,
  resolveProvenancePointer,
} from "../src/lib/care-note/provenance";
import { prisma } from "../src/lib/db";
import { createNoteFixture, deleteNoteFixture } from "./helpers/fixtures";

describe("highlight provenance", () => {
  let fixture: Awaited<ReturnType<typeof createNoteFixture>>;

  beforeEach(async () => {
    fixture = await createNoteFixture("provenance");
  });

  afterEach(async () => {
    if (!fixture) {
      return;
    }
    await deleteNoteFixture({
      clinicId: fixture.clinic.id,
      userIds: [fixture.patient.id, fixture.clinician.id],
      entryId: fixture.entry.id,
    });
  });

  it("resolves a highlight provenance pointer to the exact entry substring", async () => {
    const excerpt = "cough and fever";
    const startOffset = fixture.entry.body.indexOf(excerpt);
    const endOffset = startOffset + excerpt.length;
    const provenancePointer = createProvenancePointer(fixture.entry.id, startOffset, endOffset);

    expect(provenancePointer).toBe(`${fixture.entry.id}#${startOffset}-${endOffset}`);

    const highlight = await prisma.highlight.create({
      data: {
        careEntryId: fixture.entry.id,
        createdById: fixture.clinician.id,
        startOffset,
        endOffset,
        excerpt,
        provenancePointer,
        source: "HUMAN",
        label: "symptom",
      },
    });

    const resolved = await resolveProvenancePointer(highlight.provenancePointer ?? "");

    expect(resolved.entryId).toBe(fixture.entry.id);
    expect(resolved.entry.id).toBe(fixture.entry.id);
    expect(resolved.startOffset).toBe(startOffset);
    expect(resolved.endOffset).toBe(endOffset);
    expect(resolved.excerpt).toBe(excerpt);
    expect(resolved.excerpt).toBe(fixture.entry.body.slice(startOffset, endOffset));
  });
});
