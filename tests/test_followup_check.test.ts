import { describe, expect, it } from "vitest";
import { createAnthropicClient } from "../src/lib/agent/core/client";
import { runToolAgent } from "../src/lib/agent/core/run-agent";
import { assistantMessage, scriptedFetch, scriptResponder, toolUseBlock, type MessagesRequest } from "../src/lib/agent/core/testing";
import { coversSentence, outstandingSentences } from "../src/lib/agent/handover/outstanding";
import { followupCheckFor, systemPrompt } from "../src/lib/agent/handover/prompts";
import { followupProblems, HANDOVER_TOOLS, TOOL_NAMES, type HandoverContext } from "../src/lib/agent/handover/tools";
import { EvidenceLedger } from "../src/lib/agent/shared/record-context";

const BIOPSY = "Irregular pigmented lesion on the left shoulder. Punch biopsy taken today and histology is pending.";

function contextWith(notes: Record<string, string>, openActions: string[] = []): HandoverContext {
  const ledger = new EvidenceLedger();
  for (const [noteId, body] of Object.entries(notes)) {
    ledger.recordRead({ noteId, title: "Note", encounterAt: "2026-11-20T09:00:00.000Z", authorRole: "CLINICIAN", body, comments: [] } as never);
  }
  return {
    ledger,
    proposals: [],
    followupAttempts: [],
    followupCheck: { openActions, asked: false },
    citationMode: "quote",
    glance: async () => ({ unresolvedActions: openActions.map((text, index) => ({ id: `a${index}`, text })) }),
    timeline: async () => [],
  } as unknown as HandoverContext;
}

describe("outstanding-action detector", () => {
  it("finds pending results, requested tests and awaited reports", () => {
    expect(outstandingSentences(BIOPSY)).toEqual(["Punch biopsy taken today and histology is pending."]);
    expect(outstandingSentences("CT chest shows an incidental 8 mm lung nodule. Repeat CT in six months has been requested.")).toEqual([
      "Repeat CT in six months has been requested.",
    ]);
    expect(outstandingSentences("HbA1c ordered today; result pending.")).toHaveLength(1);
    expect(outstandingSentences("Awaiting the cardiology reply.")).toHaveLength(1);
  });

  it("stays quiet for routine reviews, closed loops and denials", () => {
    for (const text of [
      "Recheck in two weeks.",
      "Review in six months.",
      "Histology is back and benign.",
      "No results pending.",
      "Nothing outstanding.",
      "Repeat CT was cancelled by the patient.",
      "BP 132/84 on amlodipine 5 mg, well controlled.",
    ]) {
      expect(outstandingSentences(text), text).toEqual([]);
    }
  });

  it("matches a task to the sentence it is about, including short words such as CT", () => {
    expect(coversSentence("Chase histology for left shoulder biopsy", "Punch biopsy taken today and histology is pending.")).toBe(true);
    expect(coversSentence("Ensure repeat CT chest is booked", "Repeat CT in six months has been requested.")).toBe(true);
    expect(coversSentence("Chase TSH result", "HbA1c ordered today; result pending.")).toBe(false);
  });
});

describe("handover-v6 follow-up check", () => {
  it("is enabled for handover-v6 only, and the v6 prompt carries the follow-up procedure", () => {
    expect(followupCheckFor("handover-v6")).toBe(true);
    expect(followupCheckFor("handover-v4")).toBe(false);
    const v6 = systemPrompt("handover-v6");
    expect(v6).toContain("Mentioning it in the summary is not enough");
    expect(v6).not.toContain("3. Optionally call create_followup");
    expect(v6).toContain("<advice_items>");
  });

  it("asks once about an unproposed pending action, naming the note and the sentence", () => {
    const context = contextWith({ n1: BIOPSY });
    const problems = followupProblems(context);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("note n1");
    expect(problems[0]).toContain("histology is pending");
    expect(followupProblems(context)).toEqual([]);
  });

  it("does not ask when an open action, a proposal or a refused duplicate attempt covers it", () => {
    expect(followupProblems(contextWith({ n1: BIOPSY }, ["Chase biopsy histology"]))).toEqual([]);
    const proposed = contextWith({ n1: BIOPSY });
    proposed.proposals.push({ ref: "P1", text: "Chase histology result", kind: "lab_order", sourceNoteId: "n1", rationale: "Pending" });
    expect(followupProblems(proposed)).toEqual([]);
    const attempted = contextWith({ n1: BIOPSY });
    attempted.followupAttempts!.push("Follow up shoulder biopsy");
    expect(followupProblems(attempted)).toEqual([]);
    const v4 = contextWith({ n1: BIOPSY });
    delete v4.followupCheck;
    expect(followupProblems(v4)).toEqual([]);
  });

  it("drives the replayed v4 failure to a proposal: submit, asked, create_followup, resubmit", async () => {
    const submission = {
      items: [
        {
          category: "pending_action",
          severity: "warning",
          statement: "Histology results are pending for a punch biopsy taken today.",
          citations: [{ note_id: "n1", quote: "Punch biopsy taken today and histology is pending." }],
        },
      ],
    };
    const { fetch, requests } = scriptedFetch(
      scriptResponder([
        // Turn 1 is the recorded live v4 submission (evals/results/handover-challenge-50, ch-pending-biopsy).
        assistantMessage([toolUseBlock(TOOL_NAMES.submit, submission)]),
        assistantMessage([
          toolUseBlock(TOOL_NAMES.followup, { text: "Chase histology for left shoulder punch biopsy", kind: "lab_order", source_note_id: "n1", rationale: "Histology pending" }),
        ]),
        assistantMessage([toolUseBlock(TOOL_NAMES.submit, submission)]),
      ]),
    );
    const context = contextWith({ n1: BIOPSY });
    const result = await runToolAgent({
      client: createAnthropicClient({ apiKey: "test", maxRetries: 0, fetch }),
      config: { model: "m", system: systemPrompt("handover-v6"), maxIterations: 6, maxTokens: 1000, tokenBudget: 1_000_000, deadlineMs: 10_000, maxNudges: 1, maxRepairs: 1 },
      tools: HANDOVER_TOOLS,
      context,
      messages: [{ role: "user", content: "go" }],
    });
    expect(result.outcome).toBe("SUBMITTED");
    expect(context.proposals.map((proposal) => proposal.text)).toEqual(["Chase histology for left shoulder punch biopsy"]);
    const feedback = JSON.stringify((requests[1] as MessagesRequest).messages.at(-1));
    expect(feedback).toContain("follow-up check");
    expect(feedback).toContain("histology is pending");
  });
});
