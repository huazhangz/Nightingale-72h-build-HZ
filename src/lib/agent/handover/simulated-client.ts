import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageParam,
  BetaToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { findTermMentions } from "../../care-note/keyword-highlights";
import { assistantMessage, textBlock, toolUseBlock, type MessagesRequest, type Responder } from "../core/testing";
import { mulberry32 } from "../core/random";
import type { SummaryItemInput } from "./schema";
import { TOOL_NAMES } from "./tools";

/**
 * A rule-based policy that answers Messages API requests, so it drives the real handover tools through
 * the real SDK Tool Runner (via a scripted fetch). Two uses:
 *
 *  - Offline demo: the UI works without an API key (clearly labelled as simulated).
 *  - Evaluation baseline and harness self-test: with error injection it produces known rates of
 *    omission, fabricated quotes and negation flips, so graders and statistics can be checked
 *    against ground truth before any paid run.
 *
 * It is deliberately simple: it reads every available note and turns affirmed red-flag mentions
 * and plan lines into cited items. It does not "understand" the notes.
 */

export type SimulationProfile = {
  /** Probability each item is dropped (omission). */
  omitRate: number;
  /** Probability each item's quote is replaced with text not in the note (fabrication). */
  fabricateRate: number;
  /** Probability each negated red-flag mention is asserted as present (negation flip). */
  negationFlipRate: number;
  /** Propose follow-ups for documented pending actions. */
  proposeFollowups: boolean;
  seed: number;
};

export const CLEAN_PROFILE: SimulationProfile = {
  omitRate: 0,
  fabricateRate: 0,
  negationFlipRate: 0,
  proposeFollowups: true,
  seed: 1,
};

type NoteView = { note_id: string; title: string; body: string | null };

const MAX_QUOTE_WORDS = 22;

function toolResults(messages: BetaMessageParam[]): Map<string, unknown[]> {
  const names = new Map<string, string>();
  const byName = new Map<string, unknown[]>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content as Array<BetaContentBlock | BetaToolResultBlockParam>) {
      if (block.type === "tool_use") {
        names.set(block.id, block.name);
      } else if (block.type === "tool_result" && !block.is_error) {
        const name = names.get(block.tool_use_id);
        if (!name || typeof block.content !== "string") {
          continue;
        }
        const list = byName.get(name) ?? [];
        list.push(JSON.parse(block.content));
        byName.set(name, list);
      }
    }
  }
  return byName;
}

function sentences(body: string): Array<{ text: string; start: number }> {
  const result: Array<{ text: string; start: number }> = [];
  const pattern = /[^.!?\n]+[.!?]?/g;
  for (const match of body.matchAll(pattern)) {
    const text = match[0].trim();
    if (text.length > 0) {
      result.push({ text, start: (match.index ?? 0) + match[0].indexOf(text) });
    }
  }
  return result;
}

/** A verbatim window of at most MAX_QUOTE_WORDS words around [start, end) inside its sentence. */
function quoteAround(body: string, start: number, end: number): string {
  const sentence = sentences(body).find((item) => item.start <= start && start < item.start + item.text.length);
  const text = sentence?.text ?? body.slice(start, end);
  const words = text.split(/\s+/);
  if (words.length <= MAX_QUOTE_WORDS) {
    return text.replace(/[.!?]$/, "");
  }
  const offsetInSentence = start - (sentence?.start ?? start);
  const before = text.slice(0, offsetInSentence).split(/\s+/).length - 1;
  const from = Math.max(0, Math.min(before - 6, words.length - MAX_QUOTE_WORDS));
  return words.slice(from, from + MAX_QUOTE_WORDS).join(" ").replace(/[.,;:!?]$/, "");
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const FOLLOWUP_PATTERN = /\b(follow-up|follow up|labs? for|booked|pending|review in|recheck|repeat)\b/i;

/** Responder for scriptedFetch(): the simulated policy, seeded per run. */
export function simulatedResponder(profile: SimulationProfile = CLEAN_PROFILE, model = "simulated-rule-policy"): Responder {
  const policy = new SimulatedHandoverPolicy(profile, model);
  return (request) => policy.respond(request);
}

export class SimulatedHandoverPolicy {
  private readonly random: () => number;

  constructor(
    private readonly profile: SimulationProfile = CLEAN_PROFILE,
    private readonly model = "simulated-rule-policy",
  ) {
    this.random = mulberry32(profile.seed);
  }

  respond(request: MessagesRequest): BetaMessage {
    const results = toolResults(request.messages);
    const done = (name: string) => results.has(name);
    const message = (content: BetaContentBlock[]) =>
      assistantMessage(content, { model: this.model, usage: { input: 1_000, output: 200 } });

    if (!done(TOOL_NAMES.timeline)) {
      return message([
        textBlock("Reviewing the glance card and timeline."),
        toolUseBlock(TOOL_NAMES.glance, {}),
        toolUseBlock(TOOL_NAMES.timeline, { limit: 50 }),
      ]);
    }

    if (!done(TOOL_NAMES.notes)) {
      const timeline = results.get(TOOL_NAMES.timeline)![0] as {
        notes: Array<{ note_id: string; body_available: boolean }>;
      };
      const ids = timeline.notes.filter((note) => note.body_available).map((note) => note.note_id);
      if (ids.length === 0) {
        return message([toolUseBlock(TOOL_NAMES.submit, { items: [] })]);
      }
      const calls: BetaContentBlock[] = [];
      for (let index = 0; index < ids.length; index += 8) {
        calls.push(toolUseBlock(TOOL_NAMES.notes, { note_ids: ids.slice(index, index + 8) }));
      }
      return message(calls);
    }

    const notes = (results.get(TOOL_NAMES.notes) as Array<{ notes: NoteView[] }>).flatMap((result) => result.notes);
    const readable = notes.filter((note): note is NoteView & { body: string } => typeof note.body === "string");

    if (this.profile.proposeFollowups && !done(TOOL_NAMES.followup)) {
      const proposals = readable
        .map((note) => {
          const sentence = sentences(note.body).find((item) => FOLLOWUP_PATTERN.test(item.text));
          return sentence ? { note, sentence } : null;
        })
        .filter((item): item is NonNullable<typeof item> => item !== null)
        .slice(0, 3)
        .map(({ note, sentence }) =>
          toolUseBlock(TOOL_NAMES.followup, {
            text: `Confirm: ${sentence.text.split(/\s+/).slice(0, 18).join(" ")}`.slice(0, 290),
            kind: /labs?/i.test(sentence.text) ? "lab_order" : "follow_up",
            source_note_id: note.note_id,
            rationale: "Documented in the plan",
          }),
        );
      if (proposals.length > 0) {
        return message(proposals);
      }
    }

    return message([toolUseBlock(TOOL_NAMES.submit, { items: this.buildItems(readable) })]);
  }

  private buildItems(notes: Array<NoteView & { body: string }>): SummaryItemInput[] {
    const items: SummaryItemInput[] = [];
    for (const note of notes) {
      const seen = new Set<string>();
      for (const mention of findTermMentions(note.body)) {
        if (seen.has(mention.termKey)) {
          continue;
        }
        const severe = mention.baseLabel === "CRITICAL" || mention.baseLabel === "HIGH";
        const moderate = mention.baseLabel === "MEDIUM";
        if (!severe && !moderate) {
          continue;
        }
        if (mention.context === "NEGATED") {
          if (severe && this.random() < this.profile.negationFlipRate) {
            seen.add(mention.termKey);
            items.push({
              category: "critical_finding",
              severity: "critical",
              statement: `${capitalise(mention.excerpt)} reported.`,
              citations: [{ note_id: note.note_id, quote: quoteAround(note.body, mention.startOffset, mention.endOffset) }],
            });
          }
          continue;
        }
        if (mention.context !== "AFFIRMED") {
          continue;
        }
        seen.add(mention.termKey);
        items.push({
          category: severe ? "critical_finding" : "patient_concern",
          severity: severe ? "critical" : "warning",
          statement: `${capitalise(mention.excerpt)} documented in "${note.title}".`,
          citations: [{ note_id: note.note_id, quote: quoteAround(note.body, mention.startOffset, mention.endOffset) }],
        });
      }
      const plan = sentences(note.body).find((item) => /^plan\b/i.test(item.text));
      if (plan) {
        items.push({
          category: "plan",
          severity: "info",
          statement: `Plan recorded in "${note.title}".`,
          citations: [{ note_id: note.note_id, quote: quoteAround(note.body, plan.start, plan.start + plan.text.length) }],
        });
      }
    }

    return items
      .filter(() => this.random() >= this.profile.omitRate)
      .map((item) =>
        this.random() < this.profile.fabricateRate
          ? {
              ...item,
              citations: item.citations.map((citation) => ({
                ...citation,
                quote: `${citation.quote} with worsening symptoms overnight`,
              })),
            }
          : item,
      )
      .slice(0, 20);
  }
}
