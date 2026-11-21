import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAnthropicClient } from "../src/lib/agent/core/client";
import { DEFAULT_RUN_CONFIG, runToolAgent, type RunAgentConfig } from "../src/lib/agent/core/run-agent";
import { defineTool, toInputSchema, ToolInputError, type AgentTool } from "../src/lib/agent/core/tool";
import {
  assistantMessage,
  httpError,
  scriptedFetch,
  scriptResponder,
  textBlock,
  toolUseBlock,
  type MessagesRequest,
} from "../src/lib/agent/core/testing";
import type { TraceEvent } from "../src/lib/agent/core/types";

type Ctx = { calls: string[] };

const lookup = defineTool<Ctx, { key: string }>({
  name: "lookup",
  description: "Look up a value",
  schema: z.object({ key: z.string().min(1) }),
  async run(input, { context }) {
    context.calls.push(`lookup:${input.key}`);
    if (input.key === "missing") throw new ToolInputError("NOT_FOUND", "No such key");
    if (input.key === "boom") throw new Error("database exploded with secret details");
    return { key: input.key, value: input.key.toUpperCase() };
  },
});

const submit = defineTool<Ctx, { answer: string }>({
  name: "submit",
  description: "Submit the final answer",
  terminal: true,
  schema: z.object({ answer: z.string() }),
  async run() {
    throw new Error("never executed");
  },
});

const TOOLS: AgentTool<Ctx>[] = [lookup, submit];

function config(overrides: Partial<RunAgentConfig> = {}): RunAgentConfig {
  return { ...DEFAULT_RUN_CONFIG, model: "claude-opus-5-5", system: "You are a test agent.", ...overrides };
}

type Step = Parameters<typeof scriptResponder>[0][number];

async function run(steps: Step[], overrides: Partial<RunAgentConfig> = {}, options: { maxRetries?: number; signal?: AbortSignal } = {}) {
  const { fetch, requests } = scriptedFetch(scriptResponder(steps));
  const trace: TraceEvent[] = [];
  const client = createAnthropicClient({
    apiKey: "test",
    fetch,
    maxRetries: options.maxRetries ?? 0,
    onResponseStatus: (status) => status >= 400 && trace.push({ type: "http_retry", status }),
  });
  const context: Ctx = { calls: [] };
  const result = await runToolAgent({
    client,
    config: config(overrides),
    tools: TOOLS,
    context,
    messages: [{ role: "user", content: "Go" }],
    trace,
    signal: options.signal,
  });
  return { result, context, requests };
}

const toolResults = (request: MessagesRequest) =>
  request.messages.at(-1)!.content as Array<{ tool_use_id: string; content: string; is_error?: boolean }>;

describe("runToolAgent on the SDK Tool Runner", () => {
  it("runs tools through the SDK and stops on the terminal tool without executing it", async () => {
    const { result, context, requests } = await run([
      assistantMessage([textBlock("Looking up."), toolUseBlock("lookup", { key: "a" }, "t1")]),
      assistantMessage([toolUseBlock("submit", { answer: "A" }, "t2")]),
    ]);
    expect(result).toMatchObject({ outcome: "SUBMITTED", submission: { answer: "A" }, terminalTool: "submit", steps: 2 });
    expect(context.calls).toEqual(["lookup:a"]);
    expect(JSON.parse(toolResults(requests[1]!)[0]!.content)).toEqual({ key: "a", value: "A" });
    expect(result.messages.at(-1)).toMatchObject({ role: "assistant" });
    expect(requests).toHaveLength(2);
  });

  it("sends strict tools, cached system prompt, effort and refusal fallback; no server-side thread", async () => {
    const { requests } = await run([assistantMessage([toolUseBlock("submit", { answer: "x" })])]);
    const request = requests[0]! as MessagesRequest & Record<string, unknown>;
    expect(request.tools?.map((tool) => (tool as { name: string; strict?: boolean }).strict)).toEqual([true, true]);
    expect(request.output_config).toEqual({ effort: "medium" });
    expect(request.cache_control).toEqual({ type: "ephemeral" });
    expect(request.fallbacks).toBe("default");
    expect(request.thread).toBeUndefined();
    expect((request.system as Array<{ cache_control?: unknown }>)[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("returns invalid input, tool errors and crashes as safe is_error results", async () => {
    const { result, requests } = await run([
      assistantMessage([
        toolUseBlock("lookup", { key: "" }, "bad"),
        toolUseBlock("lookup", { key: "missing" }, "missing"),
        toolUseBlock("lookup", { key: "boom" }, "boom"),
      ]),
      assistantMessage([toolUseBlock("submit", { answer: "recovered" })]),
    ]);
    expect(result.outcome).toBe("SUBMITTED");
    const byId = Object.fromEntries(toolResults(requests[1]!).map((block) => [block.tool_use_id, block]));
    expect(byId.bad?.is_error).toBe(true);
    expect(JSON.parse(byId.bad!.content).error.code).toBe("INVALID_INPUT");
    expect(JSON.parse(byId.missing!.content).error).toEqual({ code: "NOT_FOUND", message: "No such key" });
    expect(byId.boom!.content).not.toMatch(/secret details/);
    expect(JSON.parse(byId.boom!.content).error.code).toBe("TOOL_FAILED");
    expect(result.trace.filter((event) => event.type === "tool_call" && !event.ok)).toHaveLength(3);
  });

  it("rejects a terminal call made in the same turn as other tool calls", async () => {
    const { result, requests } = await run([
      assistantMessage([toolUseBlock("lookup", { key: "a" }, "r"), toolUseBlock("submit", { answer: "early" }, "s")]),
      assistantMessage([toolUseBlock("submit", { answer: "after reading" })]),
    ]);
    expect(result.submission).toEqual({ answer: "after reading" });
    const submitted = toolResults(requests[1]!).find((block) => block.tool_use_id === "s")!;
    expect(JSON.parse(submitted.content).error.code).toBe("TERMINAL_NOT_ALONE");
  });

  it("lets the model fix an invalid terminal submission", async () => {
    const { result } = await run([
      assistantMessage([toolUseBlock("submit", { answer: 42 })]),
      assistantMessage([toolUseBlock("submit", { answer: "42" })]),
    ]);
    expect(result).toMatchObject({ outcome: "SUBMITTED", submission: { answer: "42" } });
  });

  it("nudges once after a prose answer, then reports NO_SUBMISSION", async () => {
    const { result, requests } = await run([
      assistantMessage([textBlock("Here is my summary in prose.")]),
      assistantMessage([textBlock("Still prose.")]),
    ]);
    expect(result.outcome).toBe("NO_SUBMISSION");
    expect(result.trace.filter((event) => event.type === "nudge")).toHaveLength(1);
    expect(JSON.stringify(requests[1]!.messages.at(-1))).toMatch(/submit/);
  });

  it("recovers after a nudge", async () => {
    const { result } = await run([
      assistantMessage([textBlock("prose")]),
      assistantMessage([toolUseBlock("submit", { answer: "ok" })]),
    ]);
    expect(result.outcome).toBe("SUBMITTED");
  });

  it("stops at the iteration limit", async () => {
    const { result, requests } = await run(
      Array.from({ length: 6 }, () => assistantMessage([toolUseBlock("lookup", { key: "loop" })])),
      { maxIterations: 3 },
    );
    expect(result.outcome).toBe("STEP_LIMIT");
    expect(requests).toHaveLength(3);
  });

  it("stops when the cumulative token budget is spent", async () => {
    const { result } = await run(
      Array.from({ length: 5 }, () => assistantMessage([toolUseBlock("lookup", { key: "k" })], { usage: { input: 600, output: 100 } })),
      { tokenBudget: 1_000 },
    );
    expect(result).toMatchObject({ outcome: "BUDGET_EXCEEDED", steps: 2 });
    expect(result.usage.inputTokens).toBe(1_200);
  });

  it("never runs tools from a turn truncated at max_tokens", async () => {
    const { result, context } = await run([
      assistantMessage([toolUseBlock("lookup", { key: "partial" })], { stopReason: "max_tokens" }),
    ]);
    expect(result.outcome).toBe("TRUNCATED");
    expect(context.calls).toEqual([]);
  });

  it("reports refusals as their own outcome", async () => {
    const { result } = await run([assistantMessage([textBlock("")], { stopReason: "refusal" })]);
    expect(result.outcome).toBe("REFUSED");
  });

  it("enforces the wall-clock deadline", async () => {
    const hanging: typeof globalThis.fetch = (_input, init) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    const result = await runToolAgent({
      client: createAnthropicClient({ apiKey: "test", fetch: hanging, maxRetries: 0 }),
      config: config({ deadlineMs: 30 }),
      tools: TOOLS,
      context: { calls: [] },
      messages: [{ role: "user", content: "Go" }],
    });
    expect(result.outcome).toBe("DEADLINE");
  });

  it("honours a caller abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const { result } = await run([assistantMessage([toolUseBlock("submit", { answer: "x" })])], {}, { signal: controller.signal });
    expect(result.outcome).toBe("ABORTED");
  });

  it("leaves retries to the SDK and records each failed HTTP attempt", async () => {
    const { result } = await run(
      [
        httpError(429, "rate_limit_error", { "retry-after-ms": "1" }),
        httpError(529, "overloaded_error", { "retry-after-ms": "1" }),
        assistantMessage([toolUseBlock("submit", { answer: "eventually" })]),
      ],
      {},
      { maxRetries: 3 },
    );
    expect(result.outcome).toBe("SUBMITTED");
    expect(result.trace.filter((event) => event.type === "http_retry").map((event) => event.type === "http_retry" && event.status)).toEqual([429, 529]);
  });

  it("reports MODEL_ERROR with the error class when retries are exhausted", async () => {
    const { result } = await run([httpError(400, "invalid_request_error")]);
    expect(result).toMatchObject({ outcome: "MODEL_ERROR", error: { kind: "bad_request", status: 400 } });
  });
});

describe("tool schemas", () => {
  it("emits strict-compatible schemas without $schema; constraints move to descriptions", () => {
    const schema = toInputSchema(z.object({ ids: z.array(z.string().min(1)).min(1).max(8) })) as Record<string, unknown>;
    expect(schema).toMatchObject({ type: "object", additionalProperties: false, required: ["ids"] });
    expect(schema).not.toHaveProperty("$schema");
    expect(JSON.stringify(schema)).toMatch(/maxItems: 8/);
  });
});
