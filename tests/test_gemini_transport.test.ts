import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAnthropicClient, type ClientFactory } from "../src/lib/agent/core/client";
import {
  fromGeminiResponse,
  geminiErrorResponse,
  geminiFetch,
  toGeminiRequest,
  toGeminiSchema,
  type GeminiPart,
  type GeminiRequest,
} from "../src/lib/agent/core/gemini";
import { toInputSchema } from "../src/lib/agent/core/tool";
import type { MessagesRequest } from "../src/lib/agent/core/testing";
import { agentSettingsFromEnv, isAgentAvailable } from "../src/lib/agent/handover/config";
import { runRiskAssessment } from "../src/lib/agent/risk/assess";
import { enqueueRiskAssessment } from "../src/lib/agent/risk/queue";
import { RISK_TOOLS, RISK_TOOL_NAMES } from "../src/lib/agent/risk/tools";
import { clearGlanceCache } from "../src/lib/cache/glanceCache";
import { prisma } from "../src/lib/db";
import { createAgentFixture, deleteAgentFixture } from "./helpers/agent-fixtures";

const submitTool = RISK_TOOLS.find((tool) => tool.name === RISK_TOOL_NAMES.submit)!;

describe("Gemini transport: mapping", () => {
  it("converts a strict tool schema to the subset Gemini accepts", () => {
    const schema = toGeminiSchema(toInputSchema(submitTool.schema) as Record<string, unknown>);
    const text = JSON.stringify(schema);
    expect(text).not.toContain("$ref");
    expect(text).not.toContain("$defs");
    expect(text).not.toContain("additionalProperties");
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(properties.level).toEqual({ enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"], type: "string" });
    const driver = (properties.drivers!.items as Record<string, unknown>).properties as Record<string, Record<string, unknown>>;
    expect(driver.citations!.items).toMatchObject({ type: "object", required: ["note_id", "quote"] });
    expect(schema.required).toEqual(["level", "review", "summary", "confidence", "drivers"]);
  });

  it("maps a tool conversation, resolves function names and returns thought signatures", () => {
    const request = {
      model: "gemini-test",
      max_tokens: 2000,
      system: [{ type: "text", text: "System prompt", cache_control: { type: "ephemeral" } }],
      tools: [{ name: "get_notes", description: "Read notes", input_schema: { type: "object", properties: { note_ids: { type: "array", items: { type: "string" } } } } }],
      messages: [
        { role: "user", content: "Assess the patient." },
        { role: "assistant", content: [{ type: "text", text: "Reading." }, { type: "tool_use", id: "toolu_gm_1", name: "get_notes", input: { note_ids: ["n1"] } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_gm_1", content: '{"notes":[]}' }] },
        { role: "user", content: [{ type: "text", text: "Submit now." }] },
      ],
    } as unknown as MessagesRequest;
    const body = toGeminiRequest(request, new Map([["toolu_gm_1", "sig-abc"]]));
    expect(body.systemInstruction).toEqual({ parts: [{ text: "System prompt" }] });
    expect(body.generationConfig).toEqual({ maxOutputTokens: 2000 });
    expect(body.tools![0]!.functionDeclarations[0]!.name).toBe("get_notes");
    expect(body.contents.map((content) => content.role)).toEqual(["user", "model", "user"]);
    expect(body.contents[1]!.parts[1]).toEqual({ functionCall: { name: "get_notes", args: { note_ids: ["n1"] } }, thoughtSignature: "sig-abc" });
    // Tool result and the follow-up text are merged into one user turn.
    expect(body.contents[2]!.parts).toEqual([
      { functionResponse: { name: "get_notes", response: { result: { notes: [] } } } },
      { text: "Submit now." },
    ]);
  });

  it("maps responses: calls to tool_use, finish reasons, usage, thoughts skipped", () => {
    const signatures = new Map<string, string>();
    let n = 0;
    const call = fromGeminiResponse(
      {
        candidates: [
          {
            content: { parts: [{ text: "thinking…", thought: true }, { text: "Let me read." }, { functionCall: { name: "get_timeline", args: { limit: 10 } }, thoughtSignature: "sig-1" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 50, thoughtsTokenCount: 200, cachedContentTokenCount: 400 },
        modelVersion: "gemini-test-001",
      },
      "gemini-test",
      signatures,
      () => String((n += 1)),
    );
    expect(call.stop_reason).toBe("tool_use");
    expect(call.model).toBe("gemini-test-001");
    expect(call.content.map((block) => block.type)).toEqual(["text", "tool_use"]);
    const toolUse = call.content[1] as { id: string; input: unknown };
    expect(toolUse.input).toEqual({ limit: 10 });
    expect(signatures.get(toolUse.id)).toBe("sig-1");
    expect(call.usage).toMatchObject({ input_tokens: 600, output_tokens: 250, cache_read_input_tokens: 400 });

    const finish = (finishReason: string, parts: GeminiPart[] = [{ text: "x" }]) =>
      fromGeminiResponse({ candidates: [{ content: { parts }, finishReason }] }, "m", signatures, () => "id").stop_reason;
    expect(finish("STOP")).toBe("end_turn");
    expect(finish("MAX_TOKENS", [{ functionCall: { name: "submit", args: {} } }])).toBe("max_tokens");
    expect(finish("SAFETY")).toBe("refusal");
    expect(fromGeminiResponse({ promptFeedback: { blockReason: "SAFETY" } }, "m", signatures, () => "id").stop_reason).toBe("refusal");
  });

  it("maps errors to Anthropic error bodies with the same status and retry-after", async () => {
    const limited = geminiErrorResponse(
      429,
      JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "17.2s" }] } }),
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("18");
    expect(await limited.json()).toEqual({ type: "error", error: { type: "rate_limit_error", message: "RESOURCE_EXHAUSTED: Quota exceeded" } });
    const billing = geminiErrorResponse(402, JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "Your prepayment credits are depleted." } }));
    expect(billing.status).toBe(402);
  });

  it("is selected with NIGHTINGALE_AGENT_CLIENT=gemini and needs GEMINI_API_KEY", () => {
    const settings = agentSettingsFromEnv({ NIGHTINGALE_AGENT_CLIENT: "gemini" } as unknown as NodeJS.ProcessEnv);
    expect(settings).toMatchObject({ client: "gemini", model: "gemini-2.5-flash", fallbacks: null });
    expect(isAgentAvailable(settings, { NIGHTINGALE_AGENT_CLIENT: "gemini" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(isAgentAvailable(settings, { NIGHTINGALE_AGENT_CLIENT: "gemini", GEMINI_API_KEY: "k" } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("Gemini transport: a full risk assessment through the production path", () => {
  let fixture: Awaited<ReturnType<typeof createAgentFixture>>;

  beforeEach(async () => {
    clearGlanceCache();
    fixture = await createAgentFixture("gemini");
  });

  afterEach(async () => {
    clearGlanceCache();
    await prisma.riskAssessment.deleteMany({ where: { clinicId: fixture.clinic.id } });
    await prisma.agentRun.deleteMany({ where: { clinicId: fixture.clinic.id } });
    await prisma.auditLog.deleteMany({ where: { actor: { clinicId: fixture.clinic.id } } });
    await prisma.user.deleteMany({ where: { clinicId: fixture.clinic.id, isServiceAccount: true } });
    await deleteAgentFixture(fixture);
  });

  /** A fake Gemini server: rate-limits once, then lists, reads and submits, checking what it receives. */
  function fakeGemini() {
    const received: Array<{ url: string; key: string | null; body: GeminiRequest }> = [];
    let calls = 0;
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as GeminiRequest;
      received.push({ url: String(input), key: new Headers(init?.headers).get("x-goog-api-key"), body });
      const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
      if (calls === 1) {
        return json({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Rate limited", details: [{ retryDelay: "0.01s" }] } }, 429);
      }
      const turn = body.contents.filter((content) => content.role === "model").length;
      const usageMetadata = { promptTokenCount: 900, candidatesTokenCount: 60 };
      if (turn === 0) {
        return json({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: RISK_TOOL_NAMES.timeline, args: { limit: 10 } }, thoughtSignature: "sig-turn-1" }] }, finishReason: "STOP" }], usageMetadata, modelVersion: "gemini-test" });
      }
      if (turn === 1) {
        return json({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: RISK_TOOL_NAMES.notes, args: { note_ids: [fixture.noteA.id] } } }] }, finishReason: "STOP" }], usageMetadata, modelVersion: "gemini-test" });
      }
      return json({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  functionCall: {
                    name: RISK_TOOL_NAMES.submit,
                    args: {
                      level: "HIGH",
                      review: "WITHIN_4H",
                      summary: "Exertional chest pain with troponin pending.",
                      confidence: "medium",
                      drivers: [{ factor: "Exertional chest pain", direction: "raises", citations: [{ note_id: fixture.noteA.id, quote: "reports chest pain on exertion since Monday" }] }],
                    },
                  },
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata,
        modelVersion: "gemini-test",
      });
    };
    return { fetchImpl, received };
  }

  it("runs tools, guardrails and the floor unchanged, retrying a 429", async () => {
    const server = fakeGemini();
    const clientFactory: ClientFactory = ({ onResponseStatus }) =>
      createAnthropicClient({ apiKey: "gemini-transport", fetch: geminiFetch({ apiKey: "test-key", fetch: server.fetchImpl }), onResponseStatus });
    const id = await enqueueRiskAssessment({ patientId: fixture.patient.id, clinicId: fixture.clinic.id, trigger: "MANUAL" });
    const done = await runRiskAssessment(id, { clientFactory, settings: { model: "gemini-test", fallbacks: null } });

    expect(done).toMatchObject({ status: "COMPLETED", method: "agent", modelLevel: "HIGH", finalLevel: "HIGH", review: "WITHIN_4H" });
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: done!.agentRunId! } });
    expect(run).toMatchObject({ status: "SUCCEEDED", outcome: "SUBMITTED", servedModel: "gemini-test", steps: 3, inputTokens: 2700, outputTokens: 180 });
    const trace = run.trace as Array<{ type: string; status?: number }>;
    expect(trace.filter((event) => event.type === "http_retry").map((event) => event.status)).toEqual([429]);

    expect(server.received).toHaveLength(4);
    expect(server.received.every((call) => call.key === "test-key" && call.url.endsWith("/models/gemini-test:generateContent"))).toBe(true);
    // The second turn sends back the first call with its thought signature and the tool's result.
    const second = server.received[2]!.body;
    expect(second.contents[1]).toMatchObject({ role: "model", parts: [{ functionCall: { name: RISK_TOOL_NAMES.timeline }, thoughtSignature: "sig-turn-1" }] });
    expect(second.contents[2]!.parts[0]!.functionResponse).toMatchObject({ name: RISK_TOOL_NAMES.timeline, response: { result: { notes: expect.any(Array) } } });
    expect(second.tools![0]!.functionDeclarations.map((declaration) => declaration.name)).toContain(RISK_TOOL_NAMES.submit);
  });
});
