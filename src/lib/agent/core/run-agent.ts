import type Anthropic from "@anthropic-ai/sdk";
import { APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageParam,
  BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { bindTools, type AgentTool } from "./tool";
import {
  emptyUsage,
  totalTokens,
  type Effort,
  type RunOutcome,
  type TraceEvent,
  type UsageTotals,
} from "./types";

/**
 * Run an agent on the Anthropic SDK Tool Runner (`client.beta.messages.toolRunner`). The SDK owns the
 * request → tools → results loop and retries; this function only decides when to stop:
 *
 *   - the terminal tool, called alone, ends the run (its input is validated, it is never executed);
 *   - refusal and max_tokens end the run before any tool of that turn runs;
 *   - iteration, token and wall-clock budgets end runaway runs;
 *   - a turn that ends without the terminal tool gets one reminder, then NO_SUBMISSION.
 *
 * `thread: false` sends the full history each turn instead of keeping server-side message threads,
 * which suits clinical data (no extra retention, works with zero-data-retention arrangements).
 */

export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export type RunAgentConfig = {
  model: string;
  system: string;
  maxIterations: number;
  maxTokens: number;
  effort?: Effort;
  tokenBudget: number;
  deadlineMs: number;
  maxNudges: number;
  fallbacks?: "default" | null;
};

export const DEFAULT_RUN_CONFIG: Omit<RunAgentConfig, "model" | "system"> = {
  maxIterations: 12,
  maxTokens: 16_000,
  effort: "medium",
  tokenBudget: 400_000,
  deadlineMs: 180_000,
  maxNudges: 1,
  fallbacks: "default",
};

export type RunAgentInput<Context> = {
  client: Anthropic;
  config: RunAgentConfig;
  tools: ReadonlyArray<AgentTool<Context>>;
  context: Context;
  messages: BetaMessageParam[];
  /** Trace array shared with the client factory, so HTTP retries land in the same trace. */
  trace?: TraceEvent[];
  signal?: AbortSignal;
};

export type RunAgentResult = {
  outcome: RunOutcome;
  /** Validated terminal-tool input when outcome is SUBMITTED. */
  submission: unknown;
  terminalTool: string | null;
  /** Full conversation, final assistant turn included. */
  messages: BetaMessageParam[];
  trace: TraceEvent[];
  usage: UsageTotals;
  steps: number;
  servedModels: string[];
  fallbackUsed: boolean;
  durationMs: number;
  error?: { kind: string; message: string; status?: number };
};

class DeadlineExceeded extends Error {
  constructor() {
    super("Agent run exceeded its deadline");
    this.name = "DeadlineExceeded";
  }
}

function usageOf(message: BetaMessage): UsageTotals {
  return {
    inputTokens: message.usage.input_tokens ?? 0,
    outputTokens: message.usage.output_tokens ?? 0,
    cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
  };
}

function usedFallback(message: BetaMessage): boolean {
  const iterations = (message.usage as { iterations?: Array<{ type?: string }> | null }).iterations;
  return (
    Boolean(iterations?.some((entry) => entry.type === "fallback_message")) ||
    message.content.some((block) => (block as { type: string }).type === "fallback")
  );
}

function errorKind(error: APIError): string {
  const status = typeof error.status === "number" ? error.status : undefined;
  if (status === 429) return "rate_limit";
  if (status === 529) return "overloaded";
  if (status === 401 || status === 403) return "auth";
  if (status === 400) return "bad_request";
  if (status === 404) return "not_found";
  if (status !== undefined && status >= 500) return "server";
  return status === undefined ? "connection" : "api";
}

function nudgeText(terminal: string[]): string {
  return (
    `You ended your turn without calling ${terminal.join(" or ")}. ` +
    `Finish now by calling ${terminal[0]} with your final result. Do not reply in plain text.`
  );
}

export async function runToolAgent<Context>(input: RunAgentInput<Context>): Promise<RunAgentResult> {
  const { client, config } = input;
  const started = Date.now();
  const trace = input.trace ?? [];
  const usage = emptyUsage();
  const servedModels = new Set<string>();
  const terminalTools = input.tools.filter((tool) => tool.terminal);
  if (terminalTools.length === 0) {
    throw new Error("runToolAgent requires a terminal tool");
  }
  const terminalNames = terminalTools.map((tool) => tool.name);
  const runnable = bindTools(input.tools, input.context, trace);
  let toolTimeMs = 0;
  const toolTime = () => trace.reduce((sum, event) => sum + (event.type === "tool_call" ? event.durationMs : 0), 0);

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new DeadlineExceeded()), config.deadlineMs);
  (deadline as { unref?: () => void }).unref?.();
  const onAbort = () => controller.abort(input.signal?.reason ?? new Error("aborted"));
  if (input.signal?.aborted) onAbort();
  else input.signal?.addEventListener("abort", onAbort, { once: true });

  let messages = [...input.messages];
  let steps = 0;
  let nudges = 0;
  let fallbackUsed = false;

  const finish = (
    outcome: RunOutcome,
    extra: { submission?: unknown; terminalTool?: string; error?: RunAgentResult["error"] } = {},
  ): RunAgentResult => ({
    outcome,
    submission: extra.submission ?? null,
    terminalTool: extra.terminalTool ?? null,
    messages,
    trace,
    usage,
    steps,
    servedModels: [...servedModels],
    fallbackUsed,
    durationMs: Date.now() - started,
    ...(extra.error ? { error: extra.error } : {}),
  });

  try {
    while (true) {
      const runner = client.beta.messages.toolRunner(
        {
          model: config.model,
          max_tokens: config.maxTokens,
          system: [{ type: "text", text: config.system, cache_control: { type: "ephemeral" } }],
          tools: runnable,
          messages,
          thread: false,
          max_iterations: Math.max(1, config.maxIterations - steps),
          cache_control: { type: "ephemeral" },
          ...(config.effort ? { output_config: { effort: config.effort } } : {}),
          ...(config.fallbacks ? { fallbacks: config.fallbacks, betas: [FALLBACK_BETA] } : {}),
        },
        { signal: controller.signal },
      );

      let turnStarted = Date.now();
      toolTimeMs = toolTime();
      let lastStop: string | null = null;
      for await (const message of runner) {
        steps += 1;
        const turnUsage = usageOf(message);
        usage.inputTokens += turnUsage.inputTokens;
        usage.outputTokens += turnUsage.outputTokens;
        usage.cacheReadInputTokens += turnUsage.cacheReadInputTokens;
        usage.cacheCreationInputTokens += turnUsage.cacheCreationInputTokens;
        servedModels.add(message.model);
        const fellBack = usedFallback(message);
        fallbackUsed ||= fellBack;
        lastStop = message.stop_reason;
        trace.push({
          type: "model_turn",
          step: steps,
          latencyMs: Math.max(0, Date.now() - turnStarted - (toolTime() - toolTimeMs)),
          stopReason: message.stop_reason,
          requestedModel: config.model,
          servedModel: message.model,
          fallbackUsed: fellBack,
          usage: turnUsage,
        });
        // While a reply is being handled the runner's params do not hold it yet.
        messages = [...runner.params.messages, { role: "assistant", content: message.content as BetaContentBlock[] }];

        if (message.stop_reason === "refusal") {
          return finish("REFUSED");
        }
        if (message.stop_reason === "max_tokens") {
          // A cut-off tool input can parse as a valid partial object: never run that turn's tools.
          return finish("TRUNCATED");
        }
        const toolUses = message.content.filter((block): block is BetaToolUseBlock => block.type === "tool_use");
        const terminal = terminalTools.find((tool) => toolUses.length === 1 && toolUses[0]!.name === tool.name);
        if (terminal) {
          const parsed = terminal.schema.safeParse(toolUses[0]!.input);
          if (parsed.success) {
            return finish("SUBMITTED", { submission: parsed.data, terminalTool: terminal.name });
          }
          // Invalid submission: let the runner return the validation error so the model can fix it.
        }
        if (totalTokens(usage) >= config.tokenBudget) {
          return finish("BUDGET_EXCEEDED");
        }
        turnStarted = Date.now();
        toolTimeMs = toolTime();
      }

      messages = [...runner.params.messages];
      if (lastStop === "tool_use" || steps >= config.maxIterations) {
        return finish("STEP_LIMIT");
      }
      if (nudges >= config.maxNudges) {
        return finish("NO_SUBMISSION");
      }
      nudges += 1;
      trace.push({ type: "nudge", step: steps });
      messages = [...messages, { role: "user", content: [{ type: "text", text: nudgeText(terminalNames) }] }];
    }
  } catch (error) {
    if (controller.signal.reason instanceof DeadlineExceeded) {
      return finish("DEADLINE", { error: { kind: "timeout", message: "Run exceeded its deadline" } });
    }
    if (controller.signal.aborted || error instanceof APIUserAbortError) {
      return finish("ABORTED", { error: { kind: "aborted", message: "Run aborted by caller" } });
    }
    if (error instanceof APIError) {
      return finish("MODEL_ERROR", {
        error: {
          kind: errorKind(error),
          message: error.message,
          ...(typeof error.status === "number" ? { status: error.status } : {}),
        },
      });
    }
    return finish("HARNESS_ERROR", {
      error: { kind: "harness", message: error instanceof Error ? error.message : String(error) },
    });
  } finally {
    clearTimeout(deadline);
    input.signal?.removeEventListener("abort", onAbort);
  }
}
