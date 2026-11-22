import type { Actor } from "../../auth/rbac";
import type { GlanceTopCard } from "../../cache/glanceCache";
import { getGlanceCard } from "../../care-note/glance";
import { getPatientTimeline } from "../../care-note/timeline";
import { segmentSentences } from "./text";
/**
 * Everything one agent run may see. It is bound to a single actor and a single patient: tools read
 * through it and never receive a patient id from the model, so a prompt-injected note cannot steer
 * the agent to another record. All reads go through the existing RBAC-checked accessors and inherit
 * the actor's permissions (a person for on-demand runs, the clinic's service account for automatic ones).
 */

type TimelineEntry = Awaited<ReturnType<typeof getPatientTimeline>>[number];

/** The clinical (non-patient) view of a timeline entry. */
export type ClinicalTimelineEntry = Extract<TimelineEntry, { authorRole: unknown }>;

export function isClinicalEntry(entry: TimelineEntry): entry is ClinicalTimelineEntry {
  return "authorRole" in entry;
}

export type LedgerNote = {
  noteId: string;
  title: string;
  encounterAt: string;
  authorRole: string;
  /** Redacted body, or null when the actor's role may only see metadata (e.g. staff + clinician draft). */
  body: string | null;
  comments: Array<{ commentId: string; authorRole: string; body: string }>;
};

/** What the model has actually been shown. Citations are verified against this, not the database. */
export type EvidenceSegment = { id: string; noteId: string; text: string };

export class EvidenceLedger {
  readonly surfacedNoteIds = new Set<string>();
  readonly surfacedHighlightIds = new Set<string>();
  readonly surfacedActionIds = new Set<string>();
  readonly readNotes = new Map<string, LedgerNote>();
  /** Evidence mode: server-issued segment ids ("N2.S3") and the exact text each one stands for. */
  readonly evidence = new Map<string, EvidenceSegment>();
  private readonly noteAliases = new Map<string, string>();

  /**
   * Segment a read note's visible text (body, then visible comments) into sentences with stable ids
   * for this run. The alias "N<k>" follows read order, so ids are short and cannot be guessed for
   * notes the run has not read.
   */
  segmentsFor(noteId: string): EvidenceSegment[] {
    const source = this.sourceText(noteId);
    if (source === null) {
      return [];
    }
    let alias = this.noteAliases.get(noteId);
    if (!alias) {
      alias = `N${this.noteAliases.size + 1}`;
      this.noteAliases.set(noteId, alias);
    }
    return segmentSentences(source).map((text, index) => {
      const segment = { id: `${alias}.S${index + 1}`, noteId, text };
      this.evidence.set(segment.id, segment);
      return segment;
    });
  }

  recordRead(note: LedgerNote): void {
    this.surfacedNoteIds.add(note.noteId);
    this.readNotes.set(note.noteId, note);
  }

  /** Text a citation may quote from: the note body plus any comments the actor was shown. */
  sourceText(noteId: string): string | null {
    const note = this.readNotes.get(noteId);
    if (!note || note.body === null) {
      return null;
    }
    return [note.body, ...note.comments.map((comment) => comment.body)].join("\n");
  }
}

export type RecordContext = {
  /** "quote" (default): tools return note text and citations quote it. "evidence": tools return
   * server-segmented sentences with ids, and citations name an id; the server supplies the text. */
  citationMode?: "quote" | "evidence";
  actor: Actor;
  patientId: string;
  now: Date;
  ledger: EvidenceLedger;
  timeline(): Promise<ClinicalTimelineEntry[]>;
  glance(): Promise<GlanceTopCard>;
};

function memo<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= load();
    return pending;
  };
}

export function createRecordContext(actor: Actor, patientId: string, now: Date = new Date()): RecordContext {
  return {
    actor,
    patientId,
    now,
    ledger: new EvidenceLedger(),
    // One snapshot per run: every tool call and the guardrails see the same record.
    timeline: memo(async () => (await getPatientTimeline(patientId, actor)).filter(isClinicalEntry)),
    glance: memo(async () => (await getGlanceCard(patientId, actor)).card),
  };
}
