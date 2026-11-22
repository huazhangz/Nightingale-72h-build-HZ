import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageParam,
  BetaToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { classifyMentionContext } from "../../src/lib/care-note/keyword-highlights";
import type { SummaryItemInput } from "../../src/lib/agent/handover/schema";
import { TOOL_NAMES } from "../../src/lib/agent/handover/tools";
import { assistantMessage, toolUseBlock, type MessagesRequest, type Responder } from "../../src/lib/agent/core/testing";
import type { MaterializedCase } from "./fixtures";

/**
 * Harness self-test baselines (eval-audit: "test the harness on known-good and known-bad"):
 *
 *  - OracleClient builds the answer from the case's own expectations, through the real tools and
 *    guardrails. It must pass ~100%; if it does not, a case or the grader is broken.
 *  - NullClient submits an empty summary immediately. It must fail every case that expects
 *    content; if it passes one, the grader is too lenient.
 */

function toolResultsByName(messages: BetaMessageParam[]): Map<string, unknown[]> {
  const names = new Map<string, string>();
  const results = new Map<string, unknown[]>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content as Array<BetaContentBlock | BetaToolResultBlockParam>) {
      if (block.type === "tool_use") {
        names.set(block.id, block.name);
      } else if (block.type === "tool_result" && !block.is_error && typeof block.content === "string") {
        const name = names.get(block.tool_use_id);
        if (name) {
          results.set(name, [...(results.get(name) ?? []), JSON.parse(block.content)]);
        }
      }
    }
  }
  return results;
}

/** Offset of the first mention of `term` asserted affirmatively (falls back to the first mention). */
function affirmedOffset(body: string, term: string): number {
  const lower = body.toLowerCase();
  const needle = term.toLowerCase();
  let first = -1;
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + 1)) {
    if (first < 0) {
      first = at;
    }
    if (classifyMentionContext(body, at) === "AFFIRMED") {
      return at;
    }
  }
  return first;
}

/** A verbatim window (<= 24 words) of the sentence containing an affirmed `term`, or null. */
export function quoteContaining(body: string, term: string): string | null {
  const at = affirmedOffset(body, term);
  if (at < 0) {
    return null;
  }
  let start = at;
  while (start > 0 && !/[.!?\n]/.test(body[start - 1]!)) {
    start -= 1;
  }
  let end = at + term.length;
  while (end < body.length && !/[.!?\n]/.test(body[end]!)) {
    end += 1;
  }
  const words = body.slice(start, end).trim().split(/\s+/);
  const termWords = term.split(/\s+/).length;
  if (words.length <= 24) {
    return words.join(" ");
  }
  const before = body.slice(start, at).trim().split(/\s+/).filter(Boolean).length;
  const from = Math.max(0, Math.min(before - 8, words.length - 24));
  const window = words.slice(from, Math.max(from + 24, before + termWords + 1));
  return window.join(" ");
}

export function nullResponder(): Responder {
  return () => assistantMessage([toolUseBlock(TOOL_NAMES.submit, { items: [] })], { model: "null-baseline" });
}

export function oracleResponder(materialized: MaterializedCase): Responder {
  const oracle = new OraclePolicy(materialized);
  return (request) => oracle.respond(request);
}

class OraclePolicy {
  constructor(private readonly materialized: MaterializedCase) {}

  respond(request: MessagesRequest): BetaMessage {
    const message = (content: BetaContentBlock[]) => assistantMessage(content, { model: "oracle-baseline" });
    const results = toolResultsByName(request.messages);
    if (!results.has(TOOL_NAMES.timeline)) {
      return message([toolUseBlock(TOOL_NAMES.glance, {}), toolUseBlock(TOOL_NAMES.timeline, { limit: 50 })]);
    }
    if (!results.has(TOOL_NAMES.notes)) {
      const timeline = results.get(TOOL_NAMES.timeline)![0] as { notes: Array<{ note_id: string; body_available: boolean }> };
      const ids = timeline.notes.filter((note) => note.body_available).map((note) => note.note_id);
      if (ids.length === 0) {
        return message([toolUseBlock(TOOL_NAMES.submit, { items: [] })]);
      }
      return message([toolUseBlock(TOOL_NAMES.notes, { note_ids: ids.slice(0, 8) })]);
    }
    // Quotable text is the body plus visible comments, exactly as the citation verifier sees it.
    const notes = (results.get(TOOL_NAMES.notes) as Array<{ notes: Array<{ note_id: string; body: string | null; comments?: Array<{ body: string }> }> }>)
      .flatMap((result) => result.notes)
      .filter((note) => typeof note.body === "string")
      .map((note) => ({ note_id: note.note_id, body: [note.body as string, ...(note.comments ?? []).map((comment) => comment.body)].join("\n") }));
    const bodyOf = new Map(notes.map((note) => [note.note_id, note.body]));
    const expect = this.materialized.expect;

    if (expect.followups.expected === "some" && !results.has(TOOL_NAMES.followup)) {
      const term = expect.followups.anyOf?.[0] ?? "result";
      const source = notes.find((note) => note.body.toLowerCase().includes(term.toLowerCase())) ?? notes[0];
      if (source) {
        return message([
          toolUseBlock(TOOL_NAMES.followup, {
            text: `Chase ${term} result`,
            kind: "lab_order",
            source_note_id: source.note_id,
            rationale: "Ordered, result pending",
          }),
        ]);
      }
    }

    const items: SummaryItemInput[] = [];
    for (const expectation of expect.mustCover) {
      const body = bodyOf.get(expectation.noteId);
      if (!body) {
        continue;
      }
      const term = expectation.anyOf.find((candidate) => body.toLowerCase().includes(candidate.toLowerCase()));
      const quote = term ? quoteContaining(body, term) : null;
      if (!term || !quote) {
        continue;
      }
      const critical = expectation.minSeverity === "critical";
      items.push({
        category: critical ? "critical_finding" : "context",
        severity: expectation.minSeverity ?? "info",
        statement: `Documented in the record: ${term}.`,
        citations: [{ note_id: expectation.noteId, quote }],
      });
    }
    return message([toolUseBlock(TOOL_NAMES.submit, { items: items.slice(0, 20) })]);
  }
}
