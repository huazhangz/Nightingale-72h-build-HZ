import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getGlanceCard } from "../src/lib/care-note/glance";
import { getPatientTimeline } from "../src/lib/care-note/timeline";
import { clearGlanceCache } from "../src/lib/cache/glanceCache";
import { prisma } from "../src/lib/db";
import { createNoteFixture, deleteNoteFixture } from "./helpers/fixtures";
import type { Actor } from "../src/lib/auth/rbac";

describe("role-scoped timeline and glance payloads", () => {
  let fixture: Awaited<ReturnType<typeof createNoteFixture>> & { staff?: { id: string } };
  let staff: Actor;
  let patientActor: Actor;
  let clinicianActor: Actor;

  beforeEach(async () => {
    clearGlanceCache();
    fixture = await createNoteFixture("scope");
    fixture.staff = await prisma.user.create({
      data: {
        email: `staff-${fixture.clinic.slug}@nightingale.test`,
        name: "Sam Staff",
        role: "STAFF",
        passwordHash: "dev-only-not-a-real-hash",
        clinicId: fixture.clinic.id,
      },
    });
    const excerpt = "cough and fever";
    const startOffset = fixture.entry.body.indexOf(excerpt);
    await prisma.comment.create({
      data: {
        careEntryId: fixture.entry.id,
        authorId: fixture.staff.id,
        body: "Internal staff comment: follow-up CRP.",
      },
    });
    await prisma.highlight.create({
      data: {
        careEntryId: fixture.entry.id,
        createdById: fixture.clinician.id,
        startOffset: startOffset >= 0 ? startOffset : 0,
        endOffset: startOffset >= 0 ? startOffset + excerpt.length : 5,
        excerpt,
        label: "risk",
        source: "MODEL",
        confidence: 0.92,
      },
    });
    patientActor = {
      id: fixture.patient.id,
      role: "PATIENT",
      clinicId: fixture.clinic.id,
    };
    staff = { id: fixture.staff.id, role: "STAFF", clinicId: fixture.clinic.id };
    clinicianActor = {
      id: fixture.clinician.id,
      role: "CLINICIAN",
      clinicId: fixture.clinic.id,
    };
  });

  afterEach(async () => {
    clearGlanceCache();
    if (!fixture) {
      return;
    }
    await deleteNoteFixture({
      clinicId: fixture.clinic.id,
      userIds: [fixture.patient.id, fixture.clinician.id, fixture.staff!.id],
      entryId: fixture.entry.id,
    });
  });

  it("strips raw body, AI highlights, and comments for patients", async () => {
    const [entry] = await getPatientTimeline(fixture.patient.id, patientActor);
    expect(entry.body).toBeUndefined();
    expect(entry.comments).toBeUndefined();
    expect(entry.highlights).toBeUndefined();
    expect(entry.revisions).toBeUndefined();
    expect(entry.version).toBeUndefined();
    expect(entry.status).toBeUndefined();
    expect(entry.authorRole).toBeUndefined();
    expect(entry.summaryReleased).toBe(false);
    expect(entry.patientFacingSummary).toBe("");
    expect(JSON.stringify(entry)).not.toMatch(/Internal staff comment/);
    expect(JSON.stringify(entry)).not.toMatch(/follow-up CRP/);
    expect(JSON.stringify(entry)).not.toMatch(/recencyScore/);
    expect(JSON.stringify(entry)).not.toMatch(/importanceScore/);
  });

  it("gives staff comments and nurse-visible fields but not unreleased clinician drafts or AI doctor highlights", async () => {
    const [entry] = await getPatientTimeline(fixture.patient.id, staff);
    expect(entry.body).toBeUndefined();
    expect(entry.comments).toHaveLength(1);
    expect(entry.comments[0]?.body).toMatch(/follow-up CRP/);
    expect(entry.highlights).toEqual([]);
    expect(entry.revisions?.some((revision) => revision.isCurrent && revision.version === 1)).toBe(true);
    expect(entry.revisions?.every((revision) => revision.body === undefined)).toBe(true);
  });

  it("returns full clinician payload including comments and AI risk highlights", async () => {
    const [entry] = await getPatientTimeline(fixture.patient.id, clinicianActor);
    expect(entry.body).toContain("Observed cough");
    expect(entry.comments).toHaveLength(1);
    expect(entry.highlights?.length).toBeGreaterThan(0);
    expect(entry.revisions?.some((revision) => revision.isCurrent && revision.version === 1)).toBe(true);
    expect(entry.revisions?.find((revision) => revision.isCurrent)?.body).toContain("Observed cough");
  });

  it("scopes glance so patients do not receive recency scores, feature weights, risk flags, or internal actions", async () => {
    const patientCard = await getGlanceCard(fixture.patient.id, patientActor);
    expect(patientCard.card.highestRiskHighlights).toEqual([]);
    expect(patientCard.card.unresolvedActions).toEqual([]);
    expect(patientCard.card.recencyScore).toBeUndefined();
    expect(JSON.stringify(patientCard.card)).not.toMatch(/recencyScore/);
    expect(JSON.stringify(patientCard.card)).not.toMatch(/importanceScore/);
    expect(JSON.stringify(patientCard.card)).not.toMatch(/Internal staff comment/);
    expect(JSON.stringify(patientCard.card)).not.toMatch(/follow-up CRP/);
    expect(patientCard.card.transparency).toBeDefined();

    const clinicianCard = await getGlanceCard(fixture.patient.id, clinicianActor);
    expect(clinicianCard.card.highestRiskHighlights.length).toBeGreaterThan(0);
    expect(clinicianCard.card.recencyScore).toEqual(expect.any(Number));
    expect(clinicianCard.card.unresolvedActions.some((action) => action.kind === "comment")).toBe(
      true,
    );
  });
});
