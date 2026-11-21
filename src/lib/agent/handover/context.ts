import type { Actor } from "../../auth/rbac";
import type { GlanceTopCard } from "../../cache/glanceCache";
import { getGlanceCard } from "../../care-note/glance";
import { getPatientTimeline } from "../../care-note/timeline";
import type { FollowupProposalDraft } from "./schema";

/**
 * Everything one handover run may see. It is bound to a single actor and a single patient: tools
 * read through it and never receive a patient id from the model, so a prompt-injected note cannot
 * steer the agent to another record. All reads go through the existing RBAC-checked accessors and
 * inherit the actor's permissions (delegation, not a service account).
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
export class EvidenceLedger {
  readonly surfacedNoteIds = new Set<string>();
  readonly surfacedHighlightIds = new Set<string>();
  readonly surfacedActionIds = new Set<string>();
  readonly readNotes = new Map<string, LedgerNote>();

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

export type HandoverContext = {
  actor: Actor;
  patientId: string;
  now: Date;
  ledger: EvidenceLedger;
  proposals: FollowupProposalDraft[];
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

export function createHandoverContext(actor: Actor, patientId: string, now: Date = new Date()): HandoverContext {
  return {
    actor,
    patientId,
    now,
    ledger: new EvidenceLedger(),
    proposals: [],
    // One snapshot per run: every tool call and the guardrails see the same record.
    timeline: memo(async () => (await getPatientTimeline(patientId, actor)).filter(isClinicalEntry)),
    glance: memo(async () => (await getGlanceCard(patientId, actor)).card),
  };
}
