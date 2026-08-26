import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCareEntry, patchCareEntry } from "../src/lib/care-note/entries";
import { findLocalRiskPhrases } from "../src/lib/care-note/keyword-highlights";
import { prisma } from "../src/lib/db";
import { createNoteFixture, deleteNoteFixture } from "./helpers/fixtures";
import type { Actor } from "../src/lib/auth/rbac";

describe("local keyword risk matcher", () => {
  it("labels critical and high phrases without overlapping shorter tokens", () => {
    const body = "Patient reports chest pain, fever, and shortness of breath. Known allergy to penicillin. Hyperpyrexia overnight.";
    const hits = findLocalRiskPhrases(body);
    const labels = Object.fromEntries(hits.map((hit) => [hit.excerpt.toLowerCase(), hit.label]));
    expect(labels["chest pain"]).toBe("CRITICAL");
    expect(labels["shortness of breath"]).toBe("CRITICAL");
    expect(labels.hyperpyrexia).toBe("CRITICAL");
    expect(labels.fever).toBe("HIGH");
    expect(labels.allergy).toBe("HIGH");
  });

  it("labels medium and low symptom phrases with matching risk colors", () => {
    const hits = findLocalRiskPhrases("Persistent cough with nausea and fatigue.");
    const labels = Object.fromEntries(hits.map((hit) => [hit.excerpt.toLowerCase(), hit.label]));
    expect(labels.cough).toBe("LOW");
    expect(labels.nausea).toBe("MEDIUM");
    expect(labels.fatigue).toBe("LOW");
  });
});

describe("local keyword highlights on note write", () => {
  let fixture: Awaited<ReturnType<typeof createNoteFixture>>;
  let clinician: Actor;

  beforeEach(async () => {
    fixture = await createNoteFixture("ner");
    clinician = {
      id: fixture.clinician.id,
      role: "CLINICIAN",
      clinicId: fixture.clinic.id,
    };
  });

  afterEach(async () => {
    if (!fixture) {
      return;
    }
    await prisma.highlight.deleteMany({ where: { careEntry: { patientId: fixture.patient.id } } });
    await prisma.careEntry.deleteMany({ where: { patientId: fixture.patient.id, id: { not: fixture.entry.id } } });
    await deleteNoteFixture({
      clinicId: fixture.clinic.id,
      userIds: [fixture.patient.id, fixture.clinician.id],
      entryId: fixture.entry.id,
    });
  });

  it("creates HIGH and CRITICAL highlights when a note is created", async () => {
    const entry = await createCareEntry(clinician, {
      patientId: fixture.patient.id,
      title: "ED triage",
      body: "Sudden chest pain with fever. No allergy documented.",
    });
    const highlights = await prisma.highlight.findMany({
      where: { careEntryId: entry.id },
      orderBy: { startOffset: "asc" },
    });
    expect(highlights.map((row) => row.label)).toEqual(["CRITICAL", "HIGH", "HIGH"]);
    expect(highlights.every((row) => row.source === "MODEL")).toBe(true);
  });

  it("refreshes keyword highlights when a note is patched", async () => {
    const updated = await patchCareEntry(clinician, fixture.entry.id, {
      body: "Now reports hyperpyrexia only.",
      baseVersion: fixture.entry.version,
    });
    const highlights = await prisma.highlight.findMany({ where: { careEntryId: updated.entry.id } });
    expect(highlights).toHaveLength(1);
    expect(highlights[0]?.label).toBe("CRITICAL");
    expect(highlights[0]?.excerpt.toLowerCase()).toBe("hyperpyrexia");
  });
});
