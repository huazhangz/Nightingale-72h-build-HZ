import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { formatZodIssues, toApiTools, ToolInputError, type AgentTool, type ToolResult } from "./tools";
import {
  abortableSleep,
  backoffDelayMs,
  classifyModelError,
  DEFAULT_RETRY_POLICY,
  type ClassifiedError,
  type RetryPolicy,
} from "./retry";
import {
  emptyUsage,
  totalTokens,
  type Effort,
  type ErrorKind,
  type LoopOutcome,
  type ModelClient,
  type ModelRequest,
  type TraceEvent,
  type UsageTotals,
} from "./types";

/**
 * A hand-written agent loop over the Messages API (no framework):
 *
 *   tools offered → model picks a tool → validate & execute → feed results back → decide to stop
 *
 * Stop conditions are explicit and each maps to a distinct LoopOutcome: terminal tool submitted,
 * step limit, cumulative token budget, wall-clock deadline, refusal, truncation, unrecoverable
 * model error, caller abort. Model calls are retried with jittered exponential backoff; the SDK's
 * own retries are disabled so every attempt is visible in the trace.
 */

export type AgentLoopConfig = {
  model: string;
  system: string;
  /** Maximum model calls in one run. */
  maxSteps: number;
  /** Per-response output cap. */
  maxTokens: number;
  effort?: Effort;
  /** Cumulative input + output + cache tokens across the run. */
  tokenBudget: number;
  /** Wall-clock ceiling for the whole run, including retries. */
  deadlineMs: number;
  retry: RetryPolicy;
  /** How many times to remind the model to call the terminal tool when it ends a turn without it. */
  maxNudges: number;
  /** Server-side refusal fallback ("default" lets the API choose the fallback chain). */
  fallbacks?: "default" | null;
  /** Cache the static prefix (tools + system) and the conversation tail. */
  promptCaching: boolean;
};

export const DEFAULT_LOOP_CONFIG: Omit<AgentLoopConfig, "model" | "system"> = {
  maxSteps: 12,
  maxTokens: 16_000,
  effort: "medium",
  tokenBudget: 400_000,
  deadlineMs: 180_000,
  retry: DEFAULT_RETRY_POLICY,
  maxNudges: 1,
  fallbacks: "default",
  promptCaching: true,
};

export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Tool results above this size are refused; tools must page instead of flooding the context. */
export const MAX_TOOL_RESULT_CHARS = 100_000;

export type LoopHooks = {
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
};

export type AgentLoopInput<Context> = {
  client: ModelClient;
  config: AgentLoopConfig;
  tools: ReadonlyArray<AgentTool<Context>>;
  context: Context;
  initialMessages: BetaMessageParam[];
  signal?: AbortSignal;
  hooks?: LoopHooks;
  onEvent?: (event: TraceEvent) => void;
};

export type AgentLoopResult = {
  outcome: LoopOutcome;
  /** Validated input of the terminal tool when outcome is SUBMITTED. */
  submission: unknown;
  terminalTool: string | null;
  messages: BetaMessageParam[];
  trace: TraceEvent[];
  usage: UsageTotals;
  steps: number;
  servedModels: string[];
  fallbackUsed: boolean;
  lastStopReason: string | null;
  durationMs: number;
  error?: { kind: ErrorKind | "harness"; message: string; status?: number };
};

class DeadlineExceeded extends Error {
  constructor() {
    super("Agent run exceeded its deadline");
    this.name = "DeadlineExceeded";
  }
}

class ModelCallFailed extends Error {
  constructor(readonly classified: ClassifiedError) {
    super(classified.message);
    this.name = "ModelCallFailed";
  }
}

function nudgeText(terminalNames: string[]): string {
  return (
    `You ended your turn without calling ${terminalNames.join(" or ")}. ` +
    `Finish now by calling ${terminalNames[0]} with your final result. Do not reply in plain text.`
  );
}

function usageOf(message: BetaMessage): UsageTotals {
  return {
    inputTokens: message.usage.input_tokens ?? 0,
    outputTokens: message.usage.output_tokens ?? 0,
    cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
  };
}

function addUsage(total: UsageTotals, delta: UsageTotals): void {
  total.inputTokens += delta.inputTokens;
  total.outputTokens += delta.outputTokens;
  total.cacheReadInputTokens += delta.cacheReadInputTokens;
  total.cacheCreationInputTokens += delta.cacheCreationInputTokens;
}

/** True when the API reports a fallback model served (part of) this response. */
function usedFallback(message: BetaMessage): boolean {
  const iterations = (message.usage as { iterations?: Array<{ type?: string }> | null }).iterations;
  if (iterations?.some((entry) => entry.type === "fallback_message")) {
    return true;
  }
  return message.content.some((block) => (block as { type: string }).type === "fallback");
}

function serialiseResult(result: ToolResult): { text: string; isError: boolean; errorCode?: string } {
  if (!result.ok) {
    return {
      text: JSON.stringify({ error: { code: result.errorCode, message: result.message } }),
      isError: true,
      errorCode: result.errorCode,
    };
  }
  const text = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
  if (text.length > MAX_TOOL_RESULT_CHARS) {
    return {
      text: JSON.stringify({
        error: { code: "RESULT_TOO_LARGE", message: "Result too large; request fewer items." },
      }),
      isError: true,
      errorCode: "RESULT_TOO_LARGE",
    };
  }
  return { text, isError: false };
}

export async function runAgentLoop<Context>(input: AgentLoopInput<Context>): Promise<AgentLoopResult> {
  const { client, config, tools, context } = input;
  const now = input.hooks?.now ?? Date.now;
  const sleep = input.hooks?.sleep ?? abortableSleep;
  const random = input.hooks?.random ?? Math.random;

  const startedAt = now();
  const messages: BetaMessageParam[] = [...input.initialMessages];
  const trace: TraceEvent[] = [];
  const usage = emptyUsage();
  const servedModels = new Set<string>();
  const apiTools = toApiTools(tools);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const terminalNames = tools.filter((tool) => tool.terminal).map((tool) => tool.name);
  if (terminalNames.length === 0) {
    throw new Error("runAgentLoop requires at least one terminal tool");
  }

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new DeadlineExceeded()), config.deadlineMs);
  (deadline as { unref?: () => void }).unref?.();
  const onExternalAbort = () => controller.abort(input.signal?.reason ?? new Error("aborted"));
  if (input.signal?.aborted) {
    onExternalAbort();
  } else {
    input.signal?.addEventListener("abort", onExternalAbort, { once: true });
  }

  let steps = 0;
  let nudges = 0;
  let fallbackUsed = false;
  let lastStopReason: string | null = null;

  const emit = (event: TraceEvent) => {
    trace.push(event);
    input.onEvent?.(event);
  };

  const finish = (
    outcome: LoopOutcome,
    extra: Partial<Pick<AgentLoopResult, "submission" | "terminalTool" | "error">> = {},
  ): AgentLoopResult => ({
    outcome,
    submission: extra.submission ?? null,
    terminalTool: extra.terminalTool ?? null,
    messages,
    trace,
    usage,
    steps,
    servedModels: [...servedModels],
    fallbackUsed,
    lastStopReason,
    durationMs: now() - startedAt,
    ...(extra.error ? { error: extra.error } : {}),
  });

  const buildRequest = (): ModelRequest => ({
    model: config.model,
    max_tokens: config.maxTokens,
    system: [
      {
        type: "text",
        text: config.system,
        ...(config.promptCaching ? { cache_control: { type: "ephemeral" as const } } : {}),
      },
    ],
    tools: apiTools,
    messages: [...messages],
    ...(config.effort ? { output_config: { effort: config.effort } } : {}),
    ...(config.promptCaching ? { cache_control: { type: "ephemeral" as const } } : {}),
    ...(config.fallbacks ? { fallbacks: config.fallbacks, betas: [FALLBACK_BETA] } : {}),
  });

  const callModel = async (step: number): Promise<BetaMessage> => {
    const request = buildRequest();
    const stepStarted = now();
    for (let attempt = 1; ; attempt += 1) {
      const attemptStarted = now();
      try {
        const response = await client.createMessage(request, { signal: controller.signal });
        const stepUsage = usageOf(response);
        addUsage(usage, stepUsage);
        servedModels.add(response.model);
        const fellBack = usedFallback(response);
        fallbackUsed ||= fellBack;
        emit({
          type: "model_call",
          step,
          latencyMs: now() - attemptStarted,
          wallMs: now() - stepStarted,
          attempts: attempt,
          stopReason: response.stop_reason,
          requestedModel: config.model,
          servedModel: response.model,
          fallbackUsed: fellBack,
          usage: stepUsage,
        });
        return response;
      } catch (error) {
        if (controller.signal.aborted) {
          throw controller.signal.reason;
        }
        const classified = classifyModelError(error);
        if (!classified.retryable || attempt >= config.retry.maxAttempts) {
          throw new ModelCallFailed(classified);
        }
        const delayMs = backoffDelayMs(attempt, config.retry, classified.retryAfterMs, random);
        emit({
          type: "model_retry",
          step,
          attempt,
          errorKind: classified.kind,
          ...(classified.status !== undefined ? { status: classified.status } : {}),
          delayMs,
        });
        await sleep(delayMs, controller.signal);
      }
    }
  };

  const executeOne = async (
    block: BetaToolUseBlock,
    step: number,
  ): Promise<{ result: BetaToolResultBlockParam; submission?: { tool: string; input: unknown } }> => {
    const started = now();
    const inputBytes = JSON.stringify(block.input ?? null).length;
    const tool = byName.get(block.name);
    let outcome: ToolResult;
    let submission: { tool: string; input: unknown } | undefined;

    if (!tool) {
      outcome = { ok: false, errorCode: "UNKNOWN_TOOL", message: `No tool named "${block.name}".` };
    } else {
      const parsed = tool.inputSchema.safeParse(block.input);
      if (!parsed.success) {
        outcome = { ok: false, errorCode: "INVALID_INPUT", message: formatZodIssues(parsed.error) };
      } else if (tool.terminal) {
        submission = { tool: tool.name, input: parsed.data };
        outcome = { ok: true, content: { status: "received" } };
      } else {
        try {
          outcome = await tool.execute(parsed.data, {
            context,
            step,
            toolUseId: block.id,
            signal: controller.signal,
          });
        } catch (error) {
          if (controller.signal.aborted) {
            throw controller.signal.reason;
          }
          outcome =
            error instanceof ToolInputError
              ? { ok: false, errorCode: error.errorCode, message: error.message }
              : { ok: false, errorCode: "TOOL_FAILED", message: "The tool failed unexpectedly." };
        }
      }
    }

    const serialised = serialiseResult(outcome);
    emit({
      type: "tool_call",
      step,
      toolUseId: block.id,
      name: block.name,
      ok: !serialised.isError,
      ...(serialised.errorCode ? { errorCode: serialised.errorCode } : {}),
      durationMs: now() - started,
      inputBytes,
      outputBytes: serialised.text.length,
    });
    return {
      result: {
        type: "tool_result",
        tool_use_id: block.id,
        content: serialised.text,
        ...(serialised.isError ? { is_error: true } : {}),
      },
      submission,
    };
  };

  const executeTools = async (blocks: BetaToolUseBlock[], step: number) => {
    const results = new Map<string, BetaToolResultBlockParam>();
    let submission: { tool: string; input: unknown } | undefined;

    const terminalCalls = blocks.filter((block) => byName.get(block.name)?.terminal);
    const otherCalls = blocks.filter((block) => !byName.get(block.name)?.terminal);

    // A terminal call is only accepted alone: a submission made in the same turn as other tool calls
    // was written before the model could read those results.
    const terminalAlone = terminalCalls.length === 1 && otherCalls.length === 0;
    for (const block of terminalCalls) {
      if (terminalAlone) {
        const executed = await executeOne(block, step);
        results.set(block.id, executed.result);
        submission = executed.submission;
      } else {
        const message =
          `${block.name} must be called alone, in a turn after you have read the results of your other ` +
          `tool calls.`;
        results.set(block.id, {
          type: "tool_result",
          tool_use_id: block.id,
          is_error: true,
          content: JSON.stringify({ error: { code: "TERMINAL_NOT_ALONE", message } }),
        });
        emit({
          type: "tool_call",
          step,
          toolUseId: block.id,
          name: block.name,
          ok: false,
          errorCode: "TERMINAL_NOT_ALONE",
          durationMs: 0,
          inputBytes: JSON.stringify(block.input ?? null).length,
          outputBytes: message.length,
        });
      }
    }

    const reads = otherCalls.filter((block) => byName.get(block.name)?.effect !== "write");
    const writes = otherCalls.filter((block) => byName.get(block.name)?.effect === "write");
    const readResults = await Promise.all(reads.map((block) => executeOne(block, step)));
    reads.forEach((block, index) => results.set(block.id, readResults[index]!.result));
    for (const block of writes) {
      results.set(block.id, (await executeOne(block, step)).result);
    }

    // All results go back in ONE user message, in the order the model emitted the calls.
    return { content: blocks.map((block) => results.get(block.id)!), submission };
  };

  try {
    while (steps < config.maxSteps) {
      steps += 1;
      const response = await callModel(steps);
      lastStopReason = response.stop_reason;
      // Append the assistant turn verbatim (thinking blocks included): the harness is append-only.
      messages.push({ role: "assistant", content: response.content as BetaContentBlock[] });

      if (response.stop_reason === "refusal") {
        return finish("REFUSED");
      }
      if (response.stop_reason === "max_tokens") {
        // A tool_use cut off at max_tokens can parse as a valid partial object; never run it.
        return finish("TRUNCATED");
      }
      if (response.stop_reason === "pause_turn") {
        continue;
      }

      const toolUses = response.content.filter((block): block is BetaToolUseBlock => block.type === "tool_use");
      if (toolUses.length === 0) {
        if (nudges < config.maxNudges) {
          nudges += 1;
          messages.push({ role: "user", content: [{ type: "text", text: nudgeText(terminalNames) }] });
          emit({ type: "nudge", step: steps, reason: "no_terminal_tool" });
          continue;
        }
        return finish("NO_SUBMISSION");
      }

      const executed = await executeTools(toolUses, steps);
      messages.push({ role: "user", content: executed.content });
      if (executed.submission) {
        return finish("SUBMITTED", {
          submission: executed.submission.input,
          terminalTool: executed.submission.tool,
        });
      }
      if (totalTokens(usage) >= config.tokenBudget) {
        return finish("BUDGET_EXCEEDED");
      }
    }
    return finish("STEP_LIMIT");
  } catch (error) {
    if (controller.signal.reason instanceof DeadlineExceeded) {
      return finish("DEADLINE", { error: { kind: "timeout", message: "Run exceeded its deadline" } });
    }
    if (controller.signal.aborted) {
      return finish("ABORTED", { error: { kind: "aborted", message: "Run aborted by caller" } });
    }
    if (error instanceof ModelCallFailed) {
      return finish("MODEL_ERROR", {
        error: {
          kind: error.classified.kind,
          message: error.classified.message,
          ...(error.classified.status !== undefined ? { status: error.classified.status } : {}),
        },
      });
    }
    return finish("HARNESS_ERROR", {
      error: { kind: "harness", message: error instanceof Error ? error.message : String(error) },
    });
  } finally {
    clearTimeout(deadline);
    input.signal?.removeEventListener("abort", onExternalAbort);
  }
}
