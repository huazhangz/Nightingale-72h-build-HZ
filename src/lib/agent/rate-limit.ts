/**
 * Per-actor sliding-window limiter for agent runs (each run spends model tokens). In-process only:
 * a multi-instance deployment needs a shared store, noted in docs/AGENT_DESIGN.md.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Records an attempt and returns whether it is allowed, plus the wait until the next slot. */
  take(key: string, now: number = Date.now()): { allowed: boolean; retryAfterMs: number } {
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return { allowed: false, retryAfterMs: this.windowMs - (now - recent[0]!) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, retryAfterMs: 0 };
  }

  reset(): void {
    this.hits.clear();
  }
}

function parseLimit(value: string | undefined): { limit: number; windowMs: number } {
  const match = value?.match(/^(\d+)\/(\d+)$/);
  if (match) {
    return { limit: Math.max(1, Number(match[1])), windowMs: Math.max(1, Number(match[2])) * 1000 };
  }
  return { limit: 6, windowMs: 10 * 60 * 1000 };
}

const configured = parseLimit(process.env.NIGHTINGALE_AGENT_RATE_LIMIT);
export const agentRunLimiter = new SlidingWindowLimiter(configured.limit, configured.windowMs);
