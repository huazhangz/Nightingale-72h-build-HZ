import type { Actor } from "../../src/lib/auth/rbac";
import { syncLocalRiskHighlights } from "../../src/lib/care-note/keyword-highlight-sync";
import { prisma } from "../../src/lib/db";
import { redactPhi } from "../../src/lib/security/redact";
import type { Severity } from "../../src/lib/agent/handover/schema";
import { normalizeForMatch } from "../../src/lib/agent/handover/text";
import type { EvalCase, NoteSpec } from "../cases/types";
import { deriveExpectationsFromFeedback, type FeedbackRow } from "./feedback";

/** Expectations with note keys resolved to the ids created for this run. */
export type ResolvedExpectations = {
  mustCover: Array<{ id: string; noteId: string; anyOf: string[]; minSeverity?: Severity; provenance: string }>;
  mustNotAssert: EvalCase["expect"]["mustNotAssert"];
  notCritical: Array<{ id: string; noteId: string; anyOf: string[] }>;
  forbiddenText: string[];
  followups: EvalCase["expect"]["followups"];
};

export type MaterializedCase = {
  evalCase: EvalCase;
  clinicId: string;
  patientId: string;
  reader: Actor;
  noteIds: Record<string, string>;
  /** Notes whose body the reader may see (the agent can only quote these). */
  readableNoteIds: string[];
  expect: ResolvedExpectations;
};

const PASSWORD = "eval-only-not-a-real-hash";

async function createNote(spec: NoteSpec, ids: { clinicId: string; patientId: string; authorId: string }) {
  const body = redactPhi(spec.body);
  const entry = await prisma.careEntry.create({
    data: {
      clinicId: ids.clinicId,
      patientId: ids.patientId,
      authorId: ids.authorId,
      title: redactPhi(spec.title),
      body,
      status: spec.status,
      version: 1,
      encounterAt: new Date(spec.encounterAt),
      revisions: { create: { editorId: ids.authorId, version: 1, body, summary: "Initial encounter note" } },
    },
  });
  // Same engine pass as production writes.
  await syncLocalRiskHighlights(entry.id, body, ids.authorId);
  return entry;
}

/**
 * Build one case in its own clinic: patient, authors, notes (with engine highlights exactly as a
 * production write produces them), comments, stored actions, clinician feedback, and an optional
 * decoy patient. Expectations derived from feedback are read back from the database.
 */
export async function materializeCase(evalCase: EvalCase, runTag: string): Promise<MaterializedCase> {
  const suffix = `${runTag}-${evalCase.id}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const clinic = await prisma.clinic.create({ data: { name: `Eval ${evalCase.id}`, slug: `eval-${suffix}` } });
  const user = (role: "PATIENT" | "STAFF" | "CLINICIAN", label: string) =>
    prisma.user.create({
      data: {
        email: `${label}-${suffix}@eval.nightingale.test`,
        name: `Eval ${label}`,
        role,
        clinicId: clinic.id,
        passwordHash: PASSWORD,
      },
    });
  const patient = await user("PATIENT", "patient");
  const clinician = await user("CLINICIAN", "clinician");
  const staff = await user("STAFF", "staff");
  const authorFor = (role: NoteSpec["authorRole"]) => (role === "CLINICIAN" ? clinician.id : staff.id);

  const noteIds: Record<string, string> = {};
  for (const spec of evalCase.notes) {
    const entry = await createNote(spec, { clinicId: clinic.id, patientId: patient.id, authorId: authorFor(spec.authorRole) });
    noteIds[spec.key] = entry.id;
    for (const comment of spec.comments ?? []) {
      await prisma.comment.create({
        data: { careEntryId: entry.id, authorId: authorFor(comment.authorRole), body: redactPhi(comment.body) },
      });
    }
    for (const feedback of spec.feedback ?? []) {
      const highlights = await prisma.highlight.findMany({ where: { careEntryId: entry.id } });
      const target = highlights.find(
        (highlight) => normalizeForMatch(highlight.excerpt) === normalizeForMatch(feedback.excerpt),
      );
      if (!target) {
        throw new Error(
          `Case ${evalCase.id}: no engine highlight "${feedback.excerpt}" in note ${spec.key} ` +
            `(have: ${highlights.map((highlight) => highlight.excerpt).join(", ")})`,
        );
      }
      await prisma.highlightFeedback.create({
        data: { highlightId: target.id, userId: clinician.id, verdict: feedback.verdict },
      });
    }
  }

  for (const action of evalCase.actions ?? []) {
    await prisma.careAction.create({
      data: {
        patientId: patient.id,
        careEntryId: noteIds[action.noteKey]!,
        createdById: clinician.id,
        sourceKey: `eval:${suffix}:${action.text}`,
        kind: action.kind,
        text: action.text,
        status: action.status,
        ...(action.status === "RESOLVED"
          ? { resolvedAt: new Date(), resolvedById: clinician.id, resolvedByRole: "CLINICIAN" }
          : {}),
      },
    });
  }

  if (evalCase.decoyPatientNotes?.length) {
    const decoy = await user("PATIENT", "decoy");
    for (const spec of evalCase.decoyPatientNotes) {
      await createNote(spec, { clinicId: clinic.id, patientId: decoy.id, authorId: authorFor(spec.authorRole) });
    }
  }

  const feedbackRows: FeedbackRow[] = (
    await prisma.highlightFeedback.findMany({
      where: { highlight: { careEntry: { patientId: patient.id } } },
      include: { highlight: true },
    })
  ).map((row) => ({
    highlightId: row.highlightId,
    noteId: row.highlight.careEntryId,
    excerpt: row.highlight.excerpt,
    label: row.highlight.label,
    verdict: row.verdict,
  }));
  const derived = deriveExpectationsFromFeedback(feedbackRows);

  const resolveKey = (key: string) => {
    const id = noteIds[key];
    if (!id) {
      throw new Error(`Case ${evalCase.id}: unknown note key "${key}"`);
    }
    return id;
  };

  const reader: Actor =
    evalCase.readerRole === "CLINICIAN"
      ? { id: clinician.id, role: "CLINICIAN", clinicId: clinic.id }
      : { id: staff.id, role: "STAFF", clinicId: clinic.id };
  const readableNoteIds = evalCase.notes
    .filter((spec) => !(evalCase.readerRole === "STAFF" && spec.authorRole === "CLINICIAN" && spec.status === "DRAFT"))
    .map((spec) => noteIds[spec.key]!);

  return {
    evalCase,
    clinicId: clinic.id,
    patientId: patient.id,
    reader,
    noteIds,
    readableNoteIds,
    expect: {
      mustCover: [
        ...evalCase.expect.mustCover.map((item) => ({
          id: item.id,
          noteId: resolveKey(item.noteKey),
          anyOf: item.anyOf,
          ...(item.minSeverity ? { minSeverity: item.minSeverity } : {}),
          provenance: item.provenance,
        })),
        ...derived.mustCover,
      ],
      mustNotAssert: evalCase.expect.mustNotAssert,
      notCritical: derived.notCritical,
      forbiddenText: evalCase.expect.forbiddenText,
      followups: evalCase.expect.followups,
    },
  };
}

/** Remove everything a materialised case created (its clinic and all rows under it). */
export async function destroyCase(clinicId: string): Promise<void> {
  const users = await prisma.user.findMany({ where: { clinicId }, select: { id: true } });
  const userIds = users.map((row) => row.id);
  const entryIds = (await prisma.careEntry.findMany({ where: { clinicId }, select: { id: true } })).map((row) => row.id);
  await prisma.agentRun.deleteMany({ where: { clinicId } });
  await prisma.careAction.deleteMany({ where: { careEntryId: { in: entryIds } } });
  await prisma.highlightFeedback.deleteMany({ where: { highlight: { careEntryId: { in: entryIds } } } });
  await prisma.highlight.deleteMany({ where: { careEntryId: { in: entryIds } } });
  await prisma.comment.deleteMany({ where: { careEntryId: { in: entryIds } } });
  await prisma.entryRevision.deleteMany({ where: { careEntryId: { in: entryIds } } });
  await prisma.careEntryViewer.deleteMany({ where: { careEntryId: { in: entryIds } } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: userIds } }, { entityId: { in: entryIds } }] } });
  await prisma.careEntry.deleteMany({ where: { id: { in: entryIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.clinic.deleteMany({ where: { id: clinicId } });
}
