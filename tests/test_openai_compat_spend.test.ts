import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAnthropicClient, type ClientFactory } from "../src/lib/agent/core/client";
import { fromChatResponse, openAICompatFetch, toChatRequest, type ChatRequest } from "../src/lib/agent/core/openai-compat";
import type { MessagesRequest } from "../src/lib/agent/core/testing";
import { runRiskAssessment } from "../src/lib/agent/risk/assess";
import { enqueueRiskAssessment } from "../src/lib/agent/risk/queue";
import { RISK_TOOL_NAMES } from "../src/lib/agent/risk/tools";
import { clearGlanceCache } from "../src/lib/cache/glanceCache";
import { prisma } from "../src/lib/db";
import { SpendGuard } from "../evals/lib/spend";
import { createAgentFixture, deleteAgentFixture } from "./helpers/agent-fixtures";

describe("OpenAI-compatible transport: mapping", () => {
  it("orders tool results right after their calls, then user text, and maps effort", () => {
    const request = {
      model: "gemini-2.5-flash",
      max_tokens: 4000,
      system: "System prompt",
      output_config: { effort: "xhigh" },
      tools: [
        { name: "get_glance_cards", description: "Glance", input_schema: { type: "object", properties: {}, additionalProperties: false } },
        { name: "get_notes", input_schema: { type: "object", properties: { note_ids: { type: "array", items: { $ref: "#/$defs/id" } } }, $defs: { id: { type: "string" } } } },
      ],
      messages: [
        { role: "user", content: "Assess." },
        { role: "assistant", content: [{ type: "text", text: "Reading." }, { type: "tool_use", id: "call_1", name: "get_notes", input: { note_ids: ["n1"] } }] },
        { role: "user", content: [{ type: "text", text: "Reminder." }, { type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: '{"notes":[]}' }] }] },
      ],
    } as unknown as MessagesRequest;
    const chat = toChatRequest(request, new Map([["call_1", { google: { thought_signature: "sig" } }]]));
    expect(chat.reasoning_effort).toBe("high");
    expect(chat.max_tokens).toBe(4000);
    expect(chat.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
    expect(chat.messages[2]).toEqual({
      role: "assistant",
      content: "Reading.",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "get_notes", arguments: '{"note_ids":["n1"]}' }, extra_content: { google: { thought_signature: "sig" } } }],
    });
    expect(chat.messages[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: '{"notes":[]}' });
    // Parameterless tools omit parameters; $ref is inlined.
    expect(chat.tools![0]!.function.parameters).toBeUndefined();
    expect(chat.tools![1]!.function.parameters).toEqual({ type: "object", properties: { note_ids: { type: "array", items: { type: "string" } } } });
  });

  it("counts thinking tokens from the total and maps finish reasons", () => {
    const extras = new Map<string, unknown>();
    const message = fromChatResponse(
      {
        model: "gemini-2.5-flash",
        choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c1", function: { name: "get_timeline", arguments: '{"limit":5}' }, extra_content: { x: 1 } }] } }],
        usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1300, prompt_tokens_details: { cached_tokens: 400 } },
      },
      "gemini-2.5-flash",
      extras,
      () => "id",
    );
    expect(message.stop_reason).toBe("tool_use");
    expect(message.usage).toMatchObject({ input_tokens: 600, output_tokens: 300, cache_read_input_tokens: 400 });
    expect(extras.get("c1")).toEqual({ x: 1 });
    const stop = (finish: string) => fromChatResponse({ choices: [{ finish_reason: finish, message: { content: "x" } }] }, "m", extras, () => "id").stop_reason;
    expect(stop("stop")).toBe("end_turn");
    expect(stop("length")).toBe("max_tokens");
    expect(stop("content_filter")).toBe("refusal");
    const broken = fromChatResponse({ choices: [{ message: { tool_calls: [{ function: { name: "get_notes", arguments: "{not json" } }] } }] }, "m", extras, () => "z");
    expect((broken.content[0] as { input: unknown }).input).toEqual({ unparsable_arguments: "{not json" });
  });
});

describe("OpenAI-compatible transport: a full risk assessment", () => {
  let fixture: Awaited<ReturnType<typeof createAgentFixture>>;

  beforeEach(async () => {
    clearGlanceCache();
    fixture = await createAgentFixture("oc");
  });

  afterEach(async () => {
    clearGlanceCache();
    await prisma.riskAssessment.deleteMany({ where: { clinicId: fixture.clinic.id } });
    await prisma.agentRun.deleteMany({ where: { clinicId: fixture.clinic.id } });
    await prisma.auditLog.deleteMany({ where: { actor: { clinicId: fixture.clinic.id } } });
    await prisma.user.deleteMany({ where: { clinicId: fixture.clinic.id, isServiceAccount: true } });
    await deleteAgentFixture(fixture);
  });

  it("runs through Chat Completions with a bearer key and the cap recording spend", async () => {
    const received: Array<{ auth: string | null; body: ChatRequest }> = [];
    const server: typeof globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as ChatRequest;
      received.push({ auth: new Headers(init?.headers).get("authorization"), body });
      const call = (name: string, args: unknown) => ({ id: `c${received.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
      const turn = body.messages.filter((message) => message.role === "assistant").length;
      const toolCall =
        turn === 0
          ? call(RISK_TOOL_NAMES.timeline, { limit: 10 })
          : turn === 1
            ? call(RISK_TOOL_NAMES.notes, { note_ids: [fixture.noteA.id] })
            : call(RISK_TOOL_NAMES.submit, {
                level: "HIGH",
                review: "WITHIN_4H",
                summary: "Exertional chest pain with troponin pending.",
                confidence: "medium",
                drivers: [{ factor: "Exertional chest pain", direction: "raises", citations: [{ note_id: fixture.noteA.id, quote: "reports chest pain on exertion since Monday" }] }],
              });
      return new Response(
        JSON.stringify({ model: "gemini-2.5-flash", choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [toolCall] } }], usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1250 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const guard = new SpendGuard(1, path.join(mkdtempSync(path.join(os.tmpdir(), "spend-")), "ledger.json"));
    const clientFactory: ClientFactory = ({ onResponseStatus }) =>
      createAnthropicClient({ apiKey: "x", fetch: guard.wrap(openAICompatFetch({ baseURL: "https://example.test/openai", apiKey: "proxy-injected", fetch: server })), onResponseStatus });
    const id = await enqueueRiskAssessment({ patientId: fixture.patient.id, clinicId: fixture.clinic.id, trigger: "MANUAL" });
    const done = await runRiskAssessment(id, { clientFactory, settings: { model: "gemini-2.5-flash", fallbacks: null } });

    expect(done).toMatchObject({ status: "COMPLETED", method: "agent", modelLevel: "HIGH", finalLevel: "HIGH" });
    expect(received).toHaveLength(3);
    expect(received.every((call) => call.auth === "Bearer proxy-injected")).toBe(true);
    expect(received[1]!.body.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool"]);
    // 3 responses × (1000 input × $0.30 + 250 output × $2.50) per million tokens.
    expect(guard.totalUsd).toBeCloseTo(3 * (1000 * 0.3 + 250 * 2.5) / 1e6, 10);
    expect(JSON.parse(readFileSync(guard.file, "utf8")).byModel["gemini-2.5-flash"].requests).toBe(3);
  });
});

describe("spend guard", () => {
  const usage = (outputTokens: number) => ({ inputTokens: 0, outputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
  const ledgerFile = () => path.join(mkdtempSync(path.join(os.tmpdir(), "spend-")), "ledger.json");

  it("refuses requests once spend plus a reserve would cross the cap, across instances", async () => {
    const file = ledgerFile();
    const guard = new SpendGuard(0.2, file);
    guard.record("gemini-2.5-flash", usage(40_000)); // $0.10
    expect(guard.exhausted()).toBe(false);
    guard.record("gemini-2.5-flash", usage(24_000)); // +$0.06 → $0.16; reserve $0.05 crosses $0.20
    expect(guard.exhausted()).toBe(true);
    // A new process reading the same ledger sees the spend.
    const next = new SpendGuard(0.2, file);
    expect(next.totalUsd).toBeCloseTo(0.16, 10);
    let called = false;
    const blocked = await next.wrap(async () => {
      called = true;
      return new Response("{}");
    })("https://x/v1/messages", { method: "POST", body: "{}" });
    expect(called).toBe(false);
    expect(blocked.status).toBe(402);
    expect((await blocked.json()).error.type).toBe("billing_error");
  });

  it("trips the cap when a served model has no known price", () => {
    const guard = new SpendGuard(5, ledgerFile());
    expect(guard.record("unpriced-model", usage(10))).toBeNull();
    expect(guard.exhausted()).toBe(true);
  });
});
