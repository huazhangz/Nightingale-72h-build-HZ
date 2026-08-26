import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/db";
import {
  extractKeywords,
  importanceScore,
  keywordFeatureKey,
  recordHighlightFeedback,
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
      where: { featureKey: keywordFeatureKey(KEYWORD) },
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
      where: { featureKey: keywordFeatureKey(KEYWORD) },
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

    const weightAfterEdit = await prisma.featureWeight.findUniqueOrThrow({
      where: { featureKey: keywordFeatureKey(KEYWORD) },
    });
    expect(weightAfterEdit.weight).toBeGreaterThan(weightAfterPin.weight);

    const afterEdit = await importanceScore(TEXT);
    expect(afterEdit).toBeGreaterThan(afterPin);
    expect(afterEdit).toBe(await importanceScore(TEXT));
  });
});
