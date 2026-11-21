import { describe, expect, it } from "vitest";
import { z } from "zod";
import { APIConnectionError, APIError } from "@anthropic-ai/sdk";
import { DEFAULT_LOOP_CONFIG, runAgentLoop, type AgentLoopConfig } from "../src/lib/agent/runtime/loop";
import { backoffDelayMs, classifyModelError } from "../src/lib/agent/runtime/retry";
import { defineTool, ToolInputError, toApiTools, type AgentTool } from "../src/lib/agent/runtime/tools";
import {
  assistantMessage,
  ScriptedModelClient,
  textBlock,
  toolUseBlock,
} from "../src/lib/agent/runtime/testing";

type Ctx = { calls: string[] };

const lookup = defineTool<Ctx, { key: string }>({
  name: "lookup",
  description: "Look up a value",
  effect: "read",
  inputSchema: z.object({ key: z.string().min(1) }),
  async execute(input, { context }) {
    context.calls.push(`lookup:${input.key}`);
    if (input.key === "missing") {
      throw new ToolInputError("NOT_FOUND", "No such key");
    }
    if (input.key === "boom") {
      throw new Error("database exploded with secret details");
    }
    return { ok: true, content: { key: input.key, value: input.key.toUpperCase() } };
  },
});

const record = defineTool<Ctx, { note: string }>({
  name: "record",
  description: "Record a note (side effect)",
  effect: "write",
  inputSchema: z.object({ note: z.string() }),
  async execute(input, { context }) {
    context.calls.push(`record:${input.note}`);
    return { ok: true, content: { saved: true } };
  },
});

const submit = defineTool<Ctx, { answer: string }>({
  name: "submit",
  description: "Submit the final answer",
  effect: "read",
  terminal: true,
  inputSchema: z.object({ answer: z.string() }),
  async execute() {
    throw new Error("terminal tools are never executed");
  },
});

const TOOLS: AgentTool<Ctx>[] = [lookup, record, submit];

function config(overrides: Partial<AgentLoopConfig> = {}): AgentLoopConfig {
  return {
    ...DEFAULT_LOOP_CONFIG,
    model: "claude-opus-5-5",
    system: "You are a test agent.",
    retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
    ...overrides,
  };
}

const noSleep = { sleep: async () => {}, random: () => 0.5 };

async function run(client: ScriptedModelClient, overrides: Partial<AgentLoopConfig> = {}) {
  const context: Ctx = { calls: [] };
  const result = await runAgentLoop({
    client,
    config: config(overrides),
    tools: TOOLS,
    context,
    initialMessages: [{ role: "user", content: "Go" }],
    hooks: noSleep,
  });
  return { result, context };
}

function rateLimit(): APIError {
  return APIError.generate(429, { type: "error", error: { type: "rate_limit_error" } }, "slow down", new Headers());
}

function overloaded(): APIError {
  return APIError.generate(529, { type: "error", error: { type: "overloaded_error" } }, "overloaded", new Headers());
}

describe("agent loop: tool calling cycle", () => {
  it("executes a tool, feeds the result back, and stops on the terminal tool", async () => {
    const client = new ScriptedModelClient([
      assistantMessage([textBlock("Looking up."), toolUseBlock("lookup", { key: "a" }, "t1")]),
      assistantMessage([toolUseBlock("submit", { answer: "A" }, "t2")]),
    ]);
    const { result, context } = await run(client);

    expect(result.outcome).toBe("SUBMITTED");
    expect(result.submission).toEqual({ answer: "A" });
    expect(result.terminalTool).toBe("submit");
    expect(result.steps).toBe(2);
    expect(context.calls).toEqual(["lookup:a"]);

    // Second request carries the assistant turn verbatim and one user message with the tool result.
    const second = client.requests[1]!;
    const [, assistant, toolTurn] = second.messages;
    expect(assistant?.role).toBe("assistant");
    expect(toolTurn?.role).toBe("user");
    const content = toolTurn?.content as Array<{ type: string; tool_use_id: string; content: string }>;
    expect(content[0]?.tool_use_id).toBe("t1");
    expect(JSON.parse(content[0]!.content)).toEqual({ key: "a", value: "A" });
  });

  it("sends tools, cached system prompt, effort and fallbacks on every request", async () => {
    const client = new ScriptedModelClient([assistantMessage([toolUseBlock("submit", { answer: "x" })])]);
    await run(client);
    const request = client.requests[0]!;
    expect(request.model).toBe("claude-opus-5-5");
    expect(request.tools?.map((tool) => (tool as { name: string }).name)).toEqual(["lookup", "record", "submit"]);
    expect(request.output_config).toEqual({ effort: "medium" });
    expect(request.cache_control).toEqual({ type: "ephemeral" });
    expect(request.fallbacks).toBe("default");
    expect(request.betas).toContain("server-side-fallback-2026-07-01");
    const system = request.system as Array<{ cache_control?: unknown }>;
    expect(system[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("returns all parallel tool results in one user message, in call order, writes after reads", async () => {
    const client = new ScriptedModelClient([
      assistantMessage([
        toolUseBlock("record", { note: "first" }, "w1"),
        toolUseBlock("lookup", { key: "x" }, "r1"),
        toolUseBlock("lookup", { key: "y" }, "r2"),
      ]),
      assistantMessage([toolUseBlock("submit", { answer: "done" })]),
    ]);
    const { result, context } = await run(client);
    expect(result.outcome).toBe("SUBMITTED");
    expect(context.calls.slice(0, 2).sort()).toEqual(["lookup:x", "lookup:y"]);
    expect(context.calls[2]).toBe("record:first");
    const toolTurn = client.requests[1]!.messages.at(-1)!;
    const ids = (toolTurn.content as Array<{ tool_use_id: string }>).map((block) => block.tool_use_id);
    expect(ids).toEqual(["w1", "r1", "r2"]);
  });
});

describe("agent loop: tool errors are returned to the model, not thrown", () => {
  it("reports invalid input, unknown tools, tool errors and crashes as is_error results", async () => {
    const client = new ScriptedModelClient([
      assistantMessage([
        toolUseBlock("lookup", { key: "" }, "bad"),
        toolUseBlock("nope", {}, "unknown"),
        toolUseBlock("lookup", { key: "missing" }, "missing"),
        toolUseBlock("lookup", { key: "boom" }, "boom"),
      ]),
      assistantMessage([toolUseBlock("submit", { answer: "recovered" })]),
    ]);
    const { result } = await run(client);
    expect(result.outcome).toBe("SUBMITTED");
    const results = client.requests[1]!.messages.at(-1)!.content as Array<{
      tool_use_id: string;
      is_error?: boolean;
      content: string;
    }>;
    const byId = Object.fromEntries(results.map((block) => [block.tool_use_id, block]));
    expect(byId.bad?.is_error).toBe(true);
    expect(JSON.parse(byId.bad!.content).error.code).toBe("INVALID_INPUT");
    expect(JSON.parse(byId.unknown!.content).error.code).toBe("UNKNOWN_TOOL");
    expect(JSON.parse(byId.missing!.content).error).toEqual({ code: "NOT_FOUND", message: "No such key" });
    // Unexpected exceptions never leak internal detail to the model.
    expect(byId.boom!.content).not.toMatch(/secret details/);
    expect(JSON.parse(byId.boom!.content).error.code).toBe("TOOL_FAILED");

    const firstStep = result.trace.filter((event) => event.type === "tool_call" && event.step === 1);
    expect(firstStep.map((event) => event.type === "tool_call" && event.ok)).toEqual([false, false, false, false]);
  });

  it("rejects a terminal call made in the same turn as other tool calls", async () => {
    const client = new ScriptedModelClient([
      assistantMessage([toolUseBlock("lookup", { key: "a" }, "r"), toolUseBlock("submit", { answer: "early" }, "s")]),
      assistantMessage([toolUseBlock("submit", { answer: "after reading" })]),
    ]);
    const { result } = await run(client);
    expect(result.outcome).toBe("SUBMITTED");
    expect(result.submission).toEqual({ answer: "after reading" });
    const firstResults = client.requests[1]!.messages.at(-1)!.content as Array<{ tool_use_id: string; content: string }>;
    expect(JSON.parse(firstResults.find((block) => block.tool_use_id === "s")!.content).error.code).toBe(
      "TERMINAL_NOT_ALONE",
    );
  });

  it("lets the model fix an invalid terminal submission", async () => {
    const client = new ScriptedModelClient([
      assistantMessage([toolUseBlock("submit", { answer: 42 })]),
      assistantMessage([toolUseBlock("submit", { answer: "42" })]),
    ]);
    const { result } = await run(client);
    expect(result.outcome).toBe("SUBMITTED");
    expect(result.submission).toEqual({ answer: "42" });
  });
});

describe("agent loop: stop conditions", () => {
  it("nudges once when the model ends its turn without submitting, then fails", async () => {
    const client = new ScriptedModelClient([
      assistantMessage([textBlock("Here is my summary in prose.")]),
      assistantMessage([textBlock("Still prose.")]),
    ]);
    const { result } = await run(client);
    expect(result.outcome).toBe("NO_SUBMISSION");
    expect(result.trace.filter((event) => event.type === "nudge")).toHaveLength(1);
    const nudge = client.requests[1]!.messages.at(-1)!;
    expect(JSON.stringify(nudge.content)).toMatch(/submit/);
  });

  it("recovers after a nudge", async () => {
    const client = new ScriptedModelClient([
      assistantMessage([textBlock("prose")]),
      assistantMessage([toolUseBlock("submit", { answer: "ok" })]),
    ]);
    expect((await run(client)).result.outcome).toBe("SUBMITTED");
  });

  it("stops at the step limit", async () => {
    const client = new ScriptedModelClient(
      Array.from({ length: 5 }, () => assistantMessage([toolUseBlock("lookup", { key: "loop" })])),
    );
    const { result } = await run(client, { maxSteps: 3 });
    expect(result.outcome).toBe("STEP_LIMIT");
    expect(client.callCount).toBe(3);
  });

  it("stops when the cumulative token budget is spent", async () => {
    const client = new ScriptedModelClient(
      Array.from({ length: 5 }, () =>
        assistantMessage([toolUseBlock("lookup", { key: "k" })], { usage: { input: 600, output: 100 } }),
      ),
    );
    const { result } = await run(client, { tokenBudget: 1_000 });
    expect(result.outcome).toBe("BUDGET_EXCEEDED");
    expect(result.steps).toBe(2);
    expect(result.usage.inputTokens).toBe(1_200);
  });

  it("never runs tools from a turn truncated at max_tokens", async () => {
    const client = new ScriptedModelClient([
      assistantMessage([toolUseBlock("record", { note: "partial" })], { stopReason: "max_tokens" }),
    ]);
    const { result, context } = await run(client);
    expect(result.outcome).toBe("TRUNCATED");
    expect(context.calls).toEqual([]);
  });

  it("reports refusals as their own outcome", async () => {
    const client = new ScriptedModelClient([assistantMessage([textBlock("")], { stopReason: "refusal" })]);
    expect((await run(client)).result.outcome).toBe("REFUSED");
  });

  it("continues after pause_turn without sending tool results", async () => {
    const client = new ScriptedModelClient([
      assistantMessage([textBlock("thinking...")], { stopReason: "pause_turn" }),
      assistantMessage([toolUseBlock("submit", { answer: "resumed" })]),
    ]);
    const { result } = await run(client);
    expect(result.outcome).toBe("SUBMITTED");
    expect(client.requests[1]!.messages.at(-1)!.role).toBe("assistant");
  });

  it("enforces the wall-clock deadline", async () => {
    const hanging = {
      provider: "hanging",
      createMessage: (_request: unknown, { signal }: { signal: AbortSignal }) =>
        new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    };
    const result = await runAgentLoop({
      client: hanging,
      config: config({ deadlineMs: 20 }),
      tools: TOOLS,
      context: { calls: [] },
      initialMessages: [{ role: "user", content: "Go" }],
      hooks: noSleep,
    });
    expect(result.outcome).toBe("DEADLINE");
  });

  it("honours a caller abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runAgentLoop({
      client: new ScriptedModelClient([assistantMessage([toolUseBlock("submit", { answer: "x" })])]),
      config: config(),
      tools: TOOLS,
      context: { calls: [] },
      initialMessages: [{ role: "user", content: "Go" }],
      signal: controller.signal,
      hooks: noSleep,
    });
    expect(result.outcome).toBe("ABORTED");
  });
});

describe("agent loop: retries", () => {
  it("retries 429 and 529 with backoff and records each attempt", async () => {
    const client = new ScriptedModelClient([
      rateLimit(),
      overloaded(),
      assistantMessage([toolUseBlock("submit", { answer: "eventually" })]),
    ]);
    const { result } = await run(client);
    expect(result.outcome).toBe("SUBMITTED");
    const retries = result.trace.filter((event) => event.type === "model_retry");
    expect(retries.map((event) => event.type === "model_retry" && event.errorKind)).toEqual([
      "rate_limit",
      "overloaded",
    ]);
    const call = result.trace.find((event) => event.type === "model_call");
    expect(call?.type === "model_call" && call.attempts).toBe(3);
  });

  it("retries connection errors", async () => {
    const client = new ScriptedModelClient([
      new APIConnectionError({ message: "socket hang up" }),
      assistantMessage([toolUseBlock("submit", { answer: "ok" })]),
    ]);
    expect((await run(client)).result.outcome).toBe("SUBMITTED");
  });

  it("gives up after maxAttempts and reports MODEL_ERROR with the error class", async () => {
    const client = new ScriptedModelClient([rateLimit(), rateLimit(), rateLimit()]);
    const { result } = await run(client);
    expect(result.outcome).toBe("MODEL_ERROR");
    expect(result.error).toMatchObject({ kind: "rate_limit", status: 429 });
    expect(client.callCount).toBe(3);
  });

  it("does not retry a 400", async () => {
    const client = new ScriptedModelClient([
      APIError.generate(400, { type: "error", error: { type: "invalid_request_error" } }, "bad", new Headers()),
    ]);
    const { result } = await run(client);
    expect(result.outcome).toBe("MODEL_ERROR");
    expect(result.error?.kind).toBe("bad_request");
    expect(client.callCount).toBe(1);
  });

  it("uses full jitter capped by maxDelay and honours retry-after", () => {
    const policy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1_000 };
    expect(backoffDelayMs(1, policy, undefined, () => 0.999)).toBeLessThan(100);
    expect(backoffDelayMs(4, policy, undefined, () => 0.999)).toBeLessThan(800);
    expect(backoffDelayMs(10, policy, undefined, () => 0.999)).toBeLessThanOrEqual(1_000);
    expect(backoffDelayMs(1, policy, 700, () => 0)).toBe(700);
    const error = APIError.generate(429, {}, "slow", new Headers({ "retry-after": "2" }));
    expect(classifyModelError(error).retryAfterMs).toBe(2_000);
  });
});

describe("tool schemas", () => {
  it("emits strict, additionalProperties:false schemas without $schema", () => {
    const [schema] = toApiTools([lookup]);
    expect(schema).toMatchObject({ name: "lookup", strict: true });
    expect(schema!.input_schema).toMatchObject({ type: "object", additionalProperties: false, required: ["key"] });
    expect(schema!.input_schema).not.toHaveProperty("$schema");
  });
});
