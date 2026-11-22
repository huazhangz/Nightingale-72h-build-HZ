/** Shared types for agents built on the Anthropic SDK Tool Runner. */

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
 * Why a run ended. Only SUBMITTED is a success. Model-behaviour outcomes (NO_SUBMISSION, STEP_LIMIT,
 * BUDGET_EXCEEDED, REFUSED, TRUNCATED) are kept apart from infrastructure outcomes so evaluations
 * never score plumbing failures as model failures.
 */
export type RunOutcome =
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

export const INFRASTRUCTURE_OUTCOMES: ReadonlySet<RunOutcome> = new Set([
  "MODEL_ERROR",
  "DEADLINE",
  "ABORTED",
  "HARNESS_ERROR",
]);

/** Metadata-only trace: names, sizes, timings and codes — never payloads (safe to persist). */
export type TraceEvent =
  | {
      type: "model_turn";
      step: number;
      /** Approximate model latency: wall time of the turn minus tool time. */
      latencyMs: number;
      stopReason: string | null;
      requestedModel: string;
      servedModel: string;
      fallbackUsed: boolean;
      usage: UsageTotals;
    }
  | { type: "http_retry"; status: number }
  /** A schema-valid terminal submission sent back for repair (problems: how many were listed). */
  | { type: "repair"; step: number; problems: number }
  | {
      type: "tool_call";
      name: string;
      ok: boolean;
      errorCode?: string;
      durationMs: number;
      inputBytes: number;
      outputBytes: number;
    }
  | { type: "nudge"; step: number };
