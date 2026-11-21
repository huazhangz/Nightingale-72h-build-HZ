import { z } from "zod";
import { redactPhi } from "../../security/redact";
import { defineTool, ToolInputError, type AgentTool } from "../core/tool";
import { looksLikeInjectedInstruction } from "../shared/injection";
import type { RecordContext } from "../shared/record-context";
import { RECORD_TOOL_NAMES, recordTools } from "../shared/record-tools";
import { normalizeForMatch } from "../shared/text";
import { FOLLOWUP_KINDS, HandoverSubmission, type FollowupProposalDraft } from "./schema";

export { MAX_NOTES_PER_CALL } from "../shared/record-tools";

/** Handover runs add follow-up proposals to the shared record context. */
export type HandoverContext = RecordContext & { proposals: FollowupProposalDraft[] };

export const TOOL_NAMES = {
  ...RECORD_TOOL_NAMES,
  followup: "create_followup",
  submit: "submit_handover_summary",
} as const;

export const MAX_PROPOSALS_PER_RUN = 5;

export function tokenSet(text: string): Set<string> {
  return new Set(normalizeForMatch(text).split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 2));
}

/**
 * Near-duplicate test for task texts: Jaccard >= 0.6, or the shorter text's tokens are (almost)
 * all contained in the longer one ("Chase TSH result" vs "Chase TSH result and adjust dose").
 */
export function isNearDuplicate(left: Set<string>, right: Set<string>): boolean {
  const intersection = [...left].filter((token) => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  const smaller = Math.min(left.size, right.size);
  const jaccard = union === 0 ? 0 : intersection / union;
  const overlap = smaller === 0 ? 0 : intersection / smaller;
  return jaccard >= 0.6 || (smaller >= 2 && overlap >= 0.8);
}

const createFollowup = defineTool<
  HandoverContext,
  { text: string; kind: (typeof FOLLOWUP_KINDS)[number]; source_note_id: string; rationale: string }
>({
  name: TOOL_NAMES.followup,
  description:
    "Draft a follow-up task for a clinician to confirm. It does NOT write to the record: it creates a proposal " +
    "that a clinician accepts or dismisses. Use it only for an outstanding action the notes document (an " +
    "ordered test with no result, a scheduled review, a pending referral) that is not already listed in " +
    "unresolved_actions from get_glance_cards. source_note_id must be a note you read with get_notes.",
  schema: z.object({
    text: z.string().min(5).max(300).describe("The task, phrased as an action (e.g. 'Chase HbA1c result')"),
    kind: z.enum(FOLLOWUP_KINDS),
    source_note_id: z.string().min(1).describe("note_id of the note that documents this action"),
    rationale: z.string().min(1).max(300).describe("Why this is outstanding, in a few words"),
  }),
  async run(input, { context }) {
    if (!context.ledger.readNotes.has(input.source_note_id)) {
      throw new ToolInputError(
        "SOURCE_NOT_READ",
        "source_note_id must be a note returned by get_notes in this session.",
      );
    }
    if (looksLikeInjectedInstruction(`${input.text} ${input.rationale}`)) {
      throw new ToolInputError(
        "INSTRUCTION_TEXT",
        "Follow-ups must describe a clinical task; text addressed to an AI is never a task.",
      );
    }
    if (context.proposals.length >= MAX_PROPOSALS_PER_RUN) {
      throw new ToolInputError("TOO_MANY_PROPOSALS", `At most ${MAX_PROPOSALS_PER_RUN} follow-ups per handover.`);
    }
    const text = redactPhi(input.text.trim());
    const candidate = tokenSet(text);
    const card = await context.glance();
    const duplicateAction = card.unresolvedActions.find((action) => isNearDuplicate(candidate, tokenSet(action.text)));
    if (duplicateAction) {
      return { status: "duplicate", duplicate_of_action_id: duplicateAction.id, message: "Already open." };
    }
    const duplicateProposal = context.proposals.find((proposal) => isNearDuplicate(candidate, tokenSet(proposal.text)));
    if (duplicateProposal) {
      return { status: "duplicate", duplicate_of_proposal: duplicateProposal.ref };
    }
    const ref = `P${context.proposals.length + 1}`;
    context.proposals.push({
      ref,
      text,
      kind: input.kind,
      sourceNoteId: input.source_note_id,
      rationale: redactPhi(input.rationale.trim()),
    });
    return { status: "proposed", proposal_ref: ref, requires_clinician_confirmation: true };
  },
});

const submitSummary = defineTool<HandoverContext, HandoverSubmission>({
  name: TOOL_NAMES.submit,
  description:
    "Submit the final handover summary and end the session. Call it exactly once, alone, after reading the " +
    "notes. Each item is one short statement with 1-3 citations; each citation gives the note_id and an exact " +
    "quote copied from that note's body or comments. Statements without a verifiable quote are discarded.",
  terminal: true,
  schema: HandoverSubmission,
  async run() {
    throw new Error("Terminal tools are never executed");
  },
});

export const HANDOVER_TOOLS: AgentTool<HandoverContext>[] = [
  ...recordTools<HandoverContext>(),
  createFollowup,
  submitSummary,
];
