import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { UsageTotals } from "../../src/lib/agent/core/types";
import { costUsd } from "./pricing";

/**
 * Hard spend cap for live evaluation runs.
 *
 * Wraps the Messages API transport (between the Anthropic SDK and the real API or a provider
 * adapter). After every successful response it prices the reported usage for the model that
 * served it and adds it to a ledger file, so the cap holds across separate commands (live check,
 * risk evaluation, handover evaluation). Before every request it refuses, with a non-retryable
 * 402, once the ledger plus a reserve for one more request would cross the cap, or when a served
 * model has no known price (spend that cannot be measured cannot be capped).
 *
 *   NIGHTINGALE_EVAL_MAX_USD=4.5                                   enables the cap
 *   NIGHTINGALE_EVAL_SPEND_FILE=evals/results/spend-ledger.json    shared ledger (default)
 *
 * Prices come from evals/lib/pricing.ts (list prices; a free tier makes the real cost lower, never
 * higher, so the cap is conservative).
 */

export type SpendLedger = {
  capUsd: number;
  totalUsd: number;
  requests: number;
  byModel: Record<string, { requests: number; usd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number }>;
  updatedAt: string;
};

/** Worst case for one more request: 16k output tokens at the highest output price in the table. */
export const RESERVE_USD = 0.05;

export class SpendGuard {
  private ledger: SpendLedger;

  constructor(
    readonly capUsd: number,
    readonly file: string,
  ) {
    const previous = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as SpendLedger) : null;
    this.ledger = {
      capUsd,
      totalUsd: previous?.totalUsd ?? 0,
      requests: previous?.requests ?? 0,
      byModel: previous?.byModel ?? {},
      updatedAt: new Date().toISOString(),
    };
  }

  get totalUsd(): number {
    return this.ledger.totalUsd;
  }

  exhausted(): boolean {
    return this.ledger.totalUsd + RESERVE_USD > this.capUsd;
  }

  record(model: string, usage: UsageTotals): number | null {
    const usd = costUsd(model, usage);
    const entry = (this.ledger.byModel[model] ??= { requests: 0, usd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
    entry.requests += 1;
    entry.inputTokens += usage.inputTokens;
    entry.outputTokens += usage.outputTokens;
    entry.cacheReadTokens += usage.cacheReadInputTokens;
    if (usd !== null) {
      entry.usd += usd;
      this.ledger.totalUsd += usd;
    } else {
      // Unknown price: make the cap trip rather than spend blind.
      this.ledger.totalUsd = Math.max(this.ledger.totalUsd, this.capUsd);
    }
    this.ledger.requests += 1;
    this.ledger.updatedAt = new Date().toISOString();
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(this.ledger, null, 2)}\n`);
    return usd;
  }

  snapshot(): SpendLedger {
    return JSON.parse(JSON.stringify(this.ledger)) as SpendLedger;
  }

  /** Wrap a Messages API fetch (the real API or a provider adapter). */
  wrap(inner: typeof globalThis.fetch): typeof globalThis.fetch {
    return async (input, init) => {
      if (this.exhausted()) {
        return new Response(
          JSON.stringify({
            type: "error",
            error: { type: "billing_error", message: `Evaluation spend cap reached: $${this.ledger.totalUsd.toFixed(4)} of $${this.capUsd.toFixed(2)}` },
          }),
          { status: 402, headers: { "content-type": "application/json" } },
        );
      }
      const response = await inner(input, init);
      if (response.ok) {
        const body = (await response.clone().json().catch(() => null)) as {
          model?: string;
          usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
        } | null;
        if (body?.usage && body.model) {
          this.record(body.model, {
            inputTokens: body.usage.input_tokens ?? 0,
            outputTokens: body.usage.output_tokens ?? 0,
            cacheReadInputTokens: body.usage.cache_read_input_tokens ?? 0,
            cacheCreationInputTokens: body.usage.cache_creation_input_tokens ?? 0,
          });
        }
      }
      return response;
    };
  }
}

let guard: SpendGuard | null | undefined;

/** The process-wide guard from the environment, or null when no cap is configured. */
export function spendGuardFromEnv(env: NodeJS.ProcessEnv = process.env): SpendGuard | null {
  if (guard !== undefined) {
    return guard;
  }
  const cap = Number.parseFloat(env.NIGHTINGALE_EVAL_MAX_USD ?? "");
  guard = Number.isFinite(cap) && cap > 0 ? new SpendGuard(cap, path.resolve(env.NIGHTINGALE_EVAL_SPEND_FILE ?? "evals/results/spend-ledger.json")) : null;
  return guard;
}

/** Fetch wrapper for live variants: identity when no cap is configured. */
export function capped(fetchImpl: typeof globalThis.fetch = globalThis.fetch): typeof globalThis.fetch {
  const active = spendGuardFromEnv();
  return active ? active.wrap(fetchImpl) : fetchImpl;
}
