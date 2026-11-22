import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createAnthropicClient, type ClientFactory } from "../src/lib/agent/core/client";
import { runToolAgent } from "../src/lib/agent/core/run-agent";
import { assistantMessage, scriptedFetch, scriptResponder, toolUseBlock, type MessagesRequest, type Responder } from "../src/lib/agent/core/testing";
import { defineTool } from "../src/lib/agent/core/tool";
import { runHandoverAgent } from "../src/lib/agent/handover/agent";
import { TOOL_NAMES } from "../src/lib/agent/handover/tools";
import { agentRunLimiter } from "../src/lib/agent/rate-limit";
import { segmentSentences } from "../src/lib/agent/shared/text";
import { clearGlanceCache } from "../src/lib/cache/glanceCache";
import { createAgentFixture, deleteAgentFixture, NOTE_A_BODY } from "./helpers/agent-fixtures";

function offline(responder: Responder): { clientFactory: ClientFactory; requests: MessagesRequest[] } {
  const { fetch, requests } = scriptedFetch(responder);
  return { requests, clientFactory: ({ onResponseStatus }) => createAnthropicClient({ apiKey: "test", maxRetries: 0, fetch, onResponseStatus }) };
}

/** Tool results (parsed JSON) the model received in the last request. */
function lastToolResults(request: MessagesRequest): Array<{ is_error?: boolean; content: string }> {
  const last = request.messages.at(-1)!;
  return (last.content as Array<{ type: string; is_error?: boolean; content: unknown }>)
    .filter((block) => block.type === "tool_result")
    .map((block) => ({ is_error: block.is_error, content: typeof block.content === "string" ? block.content : JSON.stringify(block.content) }));
}

describe("sentence segments", () => {
  it("splits on sentence ends and line breaks, every segment an exact substring", () => {
    const text = "Chest pain on exertion since Monday. Denies SOB at rest!\nPlan: ECG today; troponin. BP 142/88 stable.";
    const segments = segmentSentences(text);
    expect(segments).toEqual(["Chest pain on exertion since Monday.", "Denies SOB at rest!", "Plan: ECG today; troponin.", "BP 142/88 stable."]);
    expect(segments.every((segment) => text.includes(segment))).toBe(true);
    expect(segmentSentences(NOTE_A_BODY).every((segment) => NOTE_A_BODY.includes(segment))).toBe(true);
  });
});

describe("submit-time check and repair", () => {
  const submit = defineTool<{ seen: number }, { answer: string }>({
    name: "submit",
    description: "Submit",
    terminal: true,
    schema: z.object({ answer: z.string() }),
    check: (input) => (input.answer === "good" ? [] : [`answer "${input.answer}" is not acceptable`]),
    async run() {
      throw new Error("never");
    },
  });
  const config = { model: "m", system: "s", maxIterations: 6, maxTokens: 1000, tokenBudget: 1_000_000, deadlineMs: 10_000, maxNudges: 1 };

  it("sends a failing submission back once with the problems, then accepts the fix", async () => {
    const { clientFactory, requests } = offline(
      scriptResponder([assistantMessage([toolUseBlock("submit", { answer: "bad" })]), assistantMessage([toolUseBlock("submit", { answer: "good" })])]),
    );
    const result = await runToolAgent({ client: clientFactory({ onResponseStatus: () => {} }), config: { ...config, maxRepairs: 1 }, tools: [submit], context: { seen: 0 }, messages: [{ role: "user", content: "go" }] });
    expect(result).toMatchObject({ outcome: "SUBMITTED", submission: { answer: "good" } });
    expect(result.trace.filter((event) => event.type === "repair")).toHaveLength(1);
    const feedback = lastToolResults(requests[1]!)[0]!;
    expect(feedback.is_error).toBe(true);
    expect(feedback.content).toContain("SUBMISSION_REPAIR");
    expect(feedback.content).toContain('answer \\"bad\\" is not acceptable');
  });

  it("accepts the submission once the repair budget is spent, and keeps it if the model stops", async () => {
    const twice = offline(scriptResponder([assistantMessage([toolUseBlock("submit", { answer: "bad" })]), assistantMessage([toolUseBlock("submit", { answer: "still bad" })])]));
    const exhausted = await runToolAgent({ client: twice.clientFactory({ onResponseStatus: () => {} }), config: { ...config, maxRepairs: 1 }, tools: [submit], context: { seen: 0 }, messages: [{ role: "user", content: "go" }] });
    expect(exhausted).toMatchObject({ outcome: "SUBMITTED", submission: { answer: "still bad" } });

    const off = offline(scriptResponder([assistantMessage([toolUseBlock("submit", { answer: "bad" })])]));
    const noRepair = await runToolAgent({ client: off.clientFactory({ onResponseStatus: () => {} }), config, tools: [submit], context: { seen: 0 }, messages: [{ role: "user", content: "go" }] });
    expect(noRepair).toMatchObject({ outcome: "SUBMITTED", submission: { answer: "bad" } });

    const gaveUp = offline(scriptResponder([assistantMessage([toolUseBlock("submit", { answer: "bad" })]), assistantMessage([]), assistantMessage([])]));
    const held = await runToolAgent({ client: gaveUp.clientFactory({ onResponseStatus: () => {} }), config: { ...config, maxRepairs: 1 }, tools: [submit], context: { seen: 0 }, messages: [{ role: "user", content: "go" }] });
    expect(held).toMatchObject({ outcome: "SUBMITTED", submission: { answer: "bad" } });
  });
});

describe("handover-v5: evidence ids", () => {
  let fixture: Awaited<ReturnType<typeof createAgentFixture>>;

  beforeEach(async () => {
    clearGlanceCache();
    agentRunLimiter.reset();
    fixture = await createAgentFixture("evidence");
  });

  afterEach(async () => {
    clearGlanceCache();
    await deleteAgentFixture(fixture);
  });

  it("returns numbered sentences, resolves ids to exact text, and repairs an unknown id", async () => {
    let evidence: Array<{ id: string; text: string }> = [];
    const { clientFactory, requests } = offline((request, index) => {
      if (index === 0) return assistantMessage([toolUseBlock(TOOL_NAMES.notes, { note_ids: [fixture.noteA.id] })]);
      if (index === 1) {
        const result = JSON.parse(lastToolResults(request)[0]!.content) as { notes: Array<{ evidence: typeof evidence; body?: string }> };
        evidence = result.notes[0]!.evidence;
        expect(result.notes[0]!.body).toBeUndefined();
        const chest = evidence.find((segment) => segment.text.includes("chest pain on exertion"))!;
        return assistantMessage([
          toolUseBlock(TOOL_NAMES.submit, {
            items: [
              { category: "critical_finding", severity: "critical", statement: "Exertional chest pain since Monday.", citations: [{ evidence_id: chest.id }] },
              { category: "pending_action", severity: "warning", statement: "Troponin and ECG ordered today.", citations: [{ evidence_id: "N9.S9" }] },
            ],
          }),
        ]);
      }
      const plan = evidence.find((segment) => segment.text.startsWith("Plan"))!;
      const chest = evidence.find((segment) => segment.text.includes("chest pain on exertion"))!;
      return assistantMessage([
        toolUseBlock(TOOL_NAMES.submit, {
          items: [
            { category: "critical_finding", severity: "critical", statement: "Exertional chest pain since Monday.", citations: [{ evidence_id: chest.id }] },
            { category: "pending_action", severity: "warning", statement: "Troponin and ECG ordered today.", citations: [{ evidence_id: plan.id.toLowerCase() }] },
          ],
        }),
      ]);
    });

    const result = await runHandoverAgent(fixture.actors.clinician, fixture.patient.id, { clientFactory, promptVersion: "handover-v5", settings: { citationRepairs: 1 } });
    expect(result.outcome).toBe("SUBMITTED");
    expect(evidence.length).toBeGreaterThan(1);
    expect(evidence.every((segment) => /^N1\.S\d+$/.test(segment.id))).toBe(true);
    const repairFeedback = lastToolResults(requests[2]!)[0]!.content;
    expect(repairFeedback).toContain("N9.S9");
    expect(repairFeedback).toContain("not issued by get_notes");
    expect(result.guardrail.rejected).toEqual([]);
    const model = result.summary.items.filter((item) => item.origin === "model");
    expect(model).toHaveLength(2);
    for (const item of model) {
      expect(NOTE_A_BODY).toContain(item.citations[0]!.quote);
    }
    expect(model[1]!.citations[0]!.quote.startsWith("Plan")).toBe(true);
  });
});
