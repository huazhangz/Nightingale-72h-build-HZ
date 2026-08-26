import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/db";
import { getGlanceCard } from "../src/lib/care-note/glance";
import { clearGlanceCache } from "../src/lib/cache/glanceCache";
import {
  extractKeywords,
  importanceScore,
  keywordFeatureKey,
  recordHighlightFeedback,
  submitHighlightFeedback,
  weightDeltaForVerdict,
} from "../src/lib/learning/importance";
import { createNoteFixture, deleteNoteFixture } from "./helpers/fixtures";

const KEYWORD = "hyperpyrexia";
const TEXT = KEYWORD;

describe("self-learning importance", () => {
  let fixture: Awaited<ReturnType<typeof createNoteFixture>>;
  let highlightId: string;

  beforeEach(async () => {
    fixture = await createNoteFixture("learning");
    await prisma.featureWeight.deleteMany({
      where: { featureKey: { in: [keywordFeatureKey(KEYWORD), keywordFeatureKey("nausea")] } },
    });
    const startOffset = fixture.entry.body.indexOf("cough");
    const highlight = await prisma.highlight.create({
      data: {
        careEntryId: fixture.entry.id,
        createdById: fixture.clinician.id,
        startOffset: startOffset >= 0 ? startOffset : 0,
        endOffset: startOffset >= 0 ? startOffset + 5 : 5,
        excerpt: TEXT,
        label: "risk",
        source: "MODEL",
      },
    });
    highlightId = highlight.id;
  });

  afterEach(async () => {
    await prisma.featureWeight.deleteMany({
      where: { featureKey: { in: [keywordFeatureKey(KEYWORD), keywordFeatureKey("nausea")] } },
    });
    if (!fixture) {
      return;
    }
    await deleteNoteFixture({
      clinicId: fixture.clinic.id,
      userIds: [fixture.patient.id, fixture.clinician.id],
      entryId: fixture.entry.id,
    });
  });

  it("raises FeatureWeight and importanceScore after PIN or EDIT feedback", async () => {
    expect(extractKeywords(TEXT)).toContain(KEYWORD);

    const before = await importanceScore(TEXT);
    expect(before).toBe(0);

    await recordHighlightFeedback({
      highlightId,
      userId: fixture.clinician.id,
      verdict: "PIN",
    });

    const storedFeedback = await prisma.highlightFeedback.findUniqueOrThrow({
      where: {
        highlightId_userId: { highlightId, userId: fixture.clinician.id },
      },
    });
    expect(storedFeedback.verdict).toBe("PIN");

    const weightAfterPin = await prisma.featureWeight.findUniqueOrThrow({
      where: { featureKey: keywordFeatureKey(KEYWORD) },
    });
    expect(weightAfterPin.weight).toBeGreaterThan(0);

    const afterPin = await importanceScore(TEXT);
    expect(afterPin).toBeGreaterThan(before);

    await recordHighlightFeedback({
      highlightId,
      userId: fixture.clinician.id,
      verdict: "EDIT",
    });

    const afterEditRow = await prisma.highlightFeedback.findUniqueOrThrow({
      where: {
        highlightId_userId: { highlightId, userId: fixture.clinician.id },
      },
    });
    expect(afterEditRow.verdict).toBe("EDIT");

    const weightAfterEdit = await prisma.featureWeight.findUniqueOrThrow({
      where: { featureKey: keywordFeatureKey(KEYWORD) },
    });
    expect(weightAfterEdit.weight).toBeGreaterThan(weightAfterPin.weight);

    const afterEdit = await importanceScore(TEXT);
    expect(afterEdit).toBeGreaterThan(afterPin);
    expect(afterEdit).toBe(await importanceScore(TEXT));

    const competing = "nausea";
    expect(await importanceScore(competing)).toBeLessThan(afterEdit);

    const nauseaAt = fixture.entry.body.toLowerCase().indexOf("fever");
    await prisma.highlight.create({
      data: {
        careEntryId: fixture.entry.id,
        createdById: fixture.clinician.id,
        startOffset: Math.max(0, nauseaAt),
        endOffset: Math.max(5, nauseaAt + 5),
        excerpt: competing,
        label: "MEDIUM",
        source: "MODEL",
        confidence: 0.9,
      },
    });

    clearGlanceCache();
    const glance = await getGlanceCard(fixture.patient.id, {
      id: fixture.clinician.id,
      role: "CLINICIAN",
      clinicId: fixture.clinic.id,
    });
    const ranked = glance.card.highestRiskHighlights;
    const hyper = ranked.find((item) => item.excerpt.toLowerCase().includes(KEYWORD));
    const other = ranked.find((item) => item.excerpt.toLowerCase() === competing);
    expect(hyper).toBeTruthy();
    expect(other).toBeTruthy();
    expect(hyper!.importanceScore).toBeGreaterThan(other!.importanceScore);
    expect(ranked[0]?.id).toBe(hyper!.id);
  });

  it("does not let pinned medium terms outrank the critical reporting floor", async () => {
    const chestStart = fixture.entry.body.indexOf("cough");
    const critical = await prisma.highlight.create({
      data: {
        careEntryId: fixture.entry.id,
        createdById: fixture.clinician.id,
        startOffset: chestStart >= 0 ? chestStart : 0,
        endOffset: (chestStart >= 0 ? chestStart : 0) + 10,
        excerpt: "chest pain",
        label: "CRITICAL",
        source: "MODEL",
        confidence: 0.5,
      },
    });
    const medium = await prisma.highlight.create({
      data: {
        careEntryId: fixture.entry.id,
        createdById: fixture.clinician.id,
        startOffset: 0,
        endOffset: 6,
        excerpt: "nausea",
        label: "MEDIUM",
        source: "MODEL",
        confidence: 0.99,
      },
    });

    await submitHighlightFeedback(
      { id: fixture.clinician.id, role: "CLINICIAN", clinicId: fixture.clinic.id },
      medium.id,
      { verdict: "PIN" },
    );
    await submitHighlightFeedback(
      { id: fixture.clinician.id, role: "CLINICIAN", clinicId: fixture.clinic.id },
      medium.id,
      { verdict: "PIN" },
    );

    expect(await importanceScore("nausea")).toBeGreaterThan(await importanceScore("chest pain"));
    expect(weightDeltaForVerdict("DISAGREE", "CRITICAL")).toBe(0);

    await recordHighlightFeedback({
      highlightId: critical.id,
      userId: fixture.clinician.id,
      verdict: "DISAGREE",
    });
    const criticalWeight = await prisma.featureWeight.findUnique({
      where: { featureKey: keywordFeatureKey("chest") },
    });
    expect(criticalWeight?.weight ?? 0).toBeGreaterThanOrEqual(0);

    clearGlanceCache();
    const glance = await getGlanceCard(fixture.patient.id, {
      id: fixture.clinician.id,
      role: "CLINICIAN",
      clinicId: fixture.clinic.id,
    });
    expect(glance.card.highestRiskHighlights[0]?.id).toBe(critical.id);
    expect(glance.card.highestRiskHighlights[0]?.label).toBe("CRITICAL");
  });
});
