import type { UsageTotals } from "../../src/lib/agent/core/types";

/**
 * USD per million tokens, Anthropic first-party list prices as of 2026-11. Input/output prices and
 * the Opus 5.5 / Sonnet 5.5 cache-read prices are published list prices; other cache-read prices
 * assume 10% of input, and cache writes assume 1.25x input (5-minute TTL). Cost is computed per row
 * from recorded usage and the model that actually served the request, never from an assumed flat
 * rate. Unknown models report null cost. Re-check the pricing page before quoting totals.
 */
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};

const OFFLINE = new Set(["simulated-rule-policy", "oracle-baseline", "null-baseline", "scripted-model"]);

export function costUsd(model: string | null, usage: UsageTotals): number | null {
  if (!model) {
    return null;
  }
  if (OFFLINE.has(model)) {
    return 0;
  }
  // Exact id, or the longest alias a dated snapshot id extends ("claude-opus-5-5-20261001").
  const key = Object.keys(PRICES)
    .filter((candidate) => model === candidate || model.startsWith(`${candidate}-`))
    .sort((left, right) => right.length - left.length)[0];
  const price = key ? PRICES[key] : undefined;
  if (!price) {
    return null;
  }
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadInputTokens * price.cacheRead +
      usage.cacheCreationInputTokens * price.cacheWrite) /
    1_000_000
  );
}
