import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageParam,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

export type { BetaContentBlock, BetaMessage, BetaMessageParam };

/** The one request shape the loop sends. `stream` is always false: the loop needs whole messages. */
export type ModelRequest = Omit<MessageCreateParamsNonStreaming, "stream">;

/**
 * The model boundary. Production uses the Anthropic SDK; tests and the offline evaluation use
 * scripted or simulated clients with the same contract, so the loop is exercised identically.
 */
export interface ModelClient {
  /** Human-readable label recorded in traces (e.g. "anthropic", "scripted", "simulated"). */
  readonly provider: string;
  createMessage(request: ModelRequest, options: { signal: AbortSignal }): Promise<BetaMessage>;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
};

export function emptyUsage(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
}

export function totalTokens(usage: UsageTotals): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
}

/**
 * Why a run ended. Everything except SUBMITTED is a failure, but the classes are kept distinct so
 * the evaluation can separate model behaviour (NO_SUBMISSION, STEP_LIMIT, REFUSED, TRUNCATED) from
 * infrastructure (MODEL_ERROR, DEADLINE, ABORTED).
 */
export type LoopOutcome =
  | "SUBMITTED"
  | "NO_SUBMISSION"
  | "STEP_LIMIT"
  | "BUDGET_EXCEEDED"
  | "DEADLINE"
  | "REFUSED"
  | "TRUNCATED"
  | "MODEL_ERROR"
  | "ABORTED"
  | "HARNESS_ERROR";

/** Outcomes caused by plumbing rather than model behaviour; never scored as model failures. */
export const INFRASTRUCTURE_OUTCOMES: ReadonlySet<LoopOutcome> = new Set([
  "MODEL_ERROR",
  "DEADLINE",
  "ABORTED",
  "HARNESS_ERROR",
]);

export type ErrorKind =
  | "rate_limit"
  | "overloaded"
  | "server"
  | "connection"
  | "timeout"
  | "aborted"
  | "bad_request"
  | "auth"
  | "not_found"
  | "unknown";

export type TraceEvent =
  | {
      type: "model_call";
      step: number;
      /** Latency of the final, successful attempt only (retries and backoff excluded). */
      latencyMs: number;
      /** Wall clock for the step including retries and backoff sleeps. */
      wallMs: number;
      attempts: number;
      stopReason: string | null;
      requestedModel: string;
      servedModel: string;
      fallbackUsed: boolean;
      usage: UsageTotals;
    }
  | {
      type: "model_retry";
      step: number;
      attempt: number;
      errorKind: ErrorKind;
      status?: number;
      delayMs: number;
    }
  | {
      type: "tool_call";
      step: number;
      toolUseId: string;
      name: string;
      /** False when the tool returned an error result to the model. */
      ok: boolean;
      errorCode?: string;
      durationMs: number;
      inputBytes: number;
      outputBytes: number;
    }
  | { type: "nudge"; step: number; reason: "no_terminal_tool" };
