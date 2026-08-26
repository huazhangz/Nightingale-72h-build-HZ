import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCareEntry } from "../src/lib/care-note/entries";
import {
  createProvenancePointer,
  resolveProvenancePointer,
} from "../src/lib/care-note/provenance";
import { prisma } from "../src/lib/db";
import { createNoteFixture, deleteNoteFixture } from "./helpers/fixtures";
import type { Actor } from "../src/lib/auth/rbac";

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

  it("auto-generates MODEL highlights with provenance pointers that resolve to the exact timeline span", async () => {
    const clinician: Actor = {
      id: fixture.clinician.id,
      role: "CLINICIAN",
      clinicId: fixture.clinic.id,
    };
    const body = "Sudden chest pain with fever after climbing stairs.";
    const entry = await createCareEntry(clinician, {
      patientId: fixture.patient.id,
      title: "Auto-scribed triage",
      body,
    });
    const highlights = await prisma.highlight.findMany({
      where: { careEntryId: entry.id, source: "MODEL" },
    });
    expect(highlights.length).toBeGreaterThan(0);
    expect(highlights.every((row) => row.source === "MODEL")).toBe(true);

    for (const highlight of highlights) {
      expect(highlight.provenancePointer).toBeTruthy();
      expect(highlight.provenancePointer).toBe(
        createProvenancePointer(entry.id, highlight.startOffset, highlight.endOffset),
      );
      const resolved = await resolveProvenancePointer(highlight.provenancePointer ?? "");
      expect(resolved.entryId).toBe(entry.id);
      expect(resolved.startOffset).toBe(highlight.startOffset);
      expect(resolved.endOffset).toBe(highlight.endOffset);
      expect(resolved.excerpt).toBe(body.slice(highlight.startOffset, highlight.endOffset));
      expect(resolved.excerpt).toBe(highlight.excerpt);
    }

    await prisma.highlight.deleteMany({ where: { careEntryId: entry.id } });
    await prisma.careEntryViewer.deleteMany({ where: { careEntryId: entry.id } });
    await prisma.entryRevision.deleteMany({ where: { careEntryId: entry.id } });
    await prisma.auditLog.deleteMany({ where: { entityId: entry.id } });
    await prisma.careEntry.delete({ where: { id: entry.id } });
  });
});
