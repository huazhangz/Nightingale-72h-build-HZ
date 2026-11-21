import type { Severity } from "../../src/lib/agent/handover/schema";

/**
 * An evaluation case: an isolated clinic fixture plus what a correct handover must and must not do.
 *
 * Ground truth provenance is explicit on every expectation:
 *   - "feedback:PIN" / "feedback:AGREE": derived from HighlightFeedback rows stored with the fixture,
 *     by the same derivation that would run on production feedback (evals/lib/feedback.ts).
 *   - "author": hand-labelled by the project author from the note text. Not clinician-verified.
 * No expectation is derived from any model's output.
 */

export type NoteSpec = {
  key: string;
  title: string;
  authorRole: "CLINICIAN" | "STAFF";
  status: "DRAFT" | "SUBMITTED" | "LOCKED";
  encounterAt: string;
  body: string;
  comments?: Array<{ authorRole: "CLINICIAN" | "STAFF"; body: string }>;
  /**
   * Clinician feedback on the rule engine's highlights in this note, matched by excerpt
   * (case-insensitive). The fixture fails loudly if no highlight has that excerpt.
   */
  feedback?: Array<{ excerpt: string; verdict: "PIN" | "AGREE" | "DISAGREE" }>;
};

export type ActionSpec = { noteKey: string; text: string; kind: "plan" | "lab_order" | "follow_up"; status: "PENDING" | "RESOLVED" };

export type CoverExpectation = {
  id: string;
  noteKey: string;
  /** Satisfied when an accepted model item citing the note mentions any of these (normalised substring). */
  anyOf: string[];
  /** Only for author-labelled true emergencies. */
  minSeverity?: Severity;
  provenance: "feedback:PIN" | "feedback:AGREE" | "author";
};

export type NotAssertExpectation = {
  id: string;
  /** Lexicon phrases the record negates or only mentions as safety-net advice. */
  anyOf: string[];
  reason: "negated" | "hypothetical" | "historical" | "resolved";
};

export type EvalCase = {
  id: string;
  /** tags[0] is the stratum used for reporting: "seeded" or "adversarial". */
  tags: string[];
  description: string;
  readerRole: "CLINICIAN" | "STAFF";
  notes: NoteSpec[];
  actions?: ActionSpec[];
  /** A second patient in the same clinic; nothing from it may appear in the output. */
  decoyPatientNotes?: NoteSpec[];
  expect: {
    mustCover: CoverExpectation[];
    mustNotAssert: NotAssertExpectation[];
    /** Strings that must not appear anywhere in the agent's output (statements, quotes, proposals). */
    forbiddenText: string[];
    /** "none": proposing any follow-up is a tool misuse; "some": at least one (matching anyOf if given). */
    followups: { expected: "none" | "some" | "any"; anyOf?: string[] };
  };
};
