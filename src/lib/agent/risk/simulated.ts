import type { BetaContentBlock, BetaToolResultBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { findTermMentions } from "../../care-note/keyword-highlights";
import { assistantMessage, textBlock, toolUseBlock, type MessagesRequest, type Responder } from "../core/testing";
import { FLOOR_RULES } from "./floor";
import { maxLevel, REVIEW_FOR_LEVEL, type RiskLevel } from "./levels";
import { RISK_TOOL_NAMES } from "./tools";

/**
 * Offline rule policy for the risk agent (demo without an API key, and an evaluation baseline). It
 * drives the real tools through the real SDK Tool Runner and grades only from affirmed rule-engine
 * mentions in the most recent note, so it shares the rule engine's blind spots by design.
 */

function toolResults(messages: MessagesRequest["messages"]): Map<string, unknown[]> {
  const names = new Map<string, string>();
  const byName = new Map<string, unknown[]>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as Array<BetaContentBlock | BetaToolResultBlockParam>) {
      if (block.type === "tool_use") names.set(block.id, block.name);
      else if (block.type === "tool_result" && !block.is_error && typeof block.content === "string") {
        const name = names.get(block.tool_use_id);
        if (name) byName.set(name, [...(byName.get(name) ?? []), JSON.parse(block.content)]);
      }
    }
  }
  return byName;
}

function sentenceAround(body: string, start: number): string {
  let from = start;
  while (from > 0 && !/[.!?\n]/.test(body[from - 1]!)) from -= 1;
  let to = start;
  while (to < body.length && !/[.!?\n]/.test(body[to]!)) to += 1;
  return body.slice(from, to).trim().split(/\s+/).slice(0, 24).join(" ");
}

export function simulatedRiskResponder(model = "simulated-rule-policy"): Responder {
  return (request) => {
    const message = (content: BetaContentBlock[]) => assistantMessage(content, { model, usage: { input: 800, output: 150 } });
    const results = toolResults(request.messages);
    if (!results.has(RISK_TOOL_NAMES.timeline)) {
      return message([textBlock("Reviewing the record."), toolUseBlock(RISK_TOOL_NAMES.glance, {}), toolUseBlock(RISK_TOOL_NAMES.timeline, { limit: 10 })]);
    }
    const timeline = results.get(RISK_TOOL_NAMES.timeline)![0] as { notes: Array<{ note_id: string; body_available: boolean }> };
    const latest = timeline.notes.find((note) => note.body_available);
    if (!latest) {
      return message([
        toolUseBlock(RISK_TOOL_NAMES.submit, {
          level: "LOW",
          review: "ROUTINE",
          summary: "No readable notes.",
          confidence: "low",
          drivers: [{ factor: "No documentation", direction: "lowers", citations: [{ note_id: "none", quote: "no notes" }] }],
        }),
      ]);
    }
    if (!results.has(RISK_TOOL_NAMES.notes)) {
      return message([toolUseBlock(RISK_TOOL_NAMES.notes, { note_ids: [latest.note_id] })]);
    }
    const note = (results.get(RISK_TOOL_NAMES.notes)![0] as { notes: Array<{ note_id: string; body: string | null }> }).notes[0]!;
    const body = note.body ?? "";
    const drivers: Array<{ factor: string; direction: "raises"; citations: Array<{ note_id: string; quote: string }> }> = [];
    let level: RiskLevel = "LOW";
    const seen = new Set<string>();
    for (const mention of findTermMentions(body)) {
      const rule = FLOOR_RULES[mention.termKey];
      if (!rule || mention.context !== "AFFIRMED" || seen.has(mention.termKey)) continue;
      seen.add(mention.termKey);
      level = maxLevel(level, rule.level);
      drivers.push({ factor: rule.label, direction: "raises", citations: [{ note_id: note.note_id, quote: sentenceAround(body, mention.startOffset) }] });
    }
    if (drivers.length === 0) {
      drivers.push({ factor: "No rule-flagged finding in the latest note", direction: "raises", citations: [{ note_id: note.note_id, quote: body.split(/\s+/).slice(0, 12).join(" ") }] });
    }
    return message([
      toolUseBlock(RISK_TOOL_NAMES.submit, {
        level,
        review: REVIEW_FOR_LEVEL[level],
        summary: `Rule policy: ${drivers.map((driver) => driver.factor).join(", ")}.`,
        confidence: "low",
        drivers: drivers.slice(0, 6),
      }),
    ]);
  };
}
