import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import type { ErrorKind } from "./types";

export type RetryPolicy = {
  /** Total attempts per model call, including the first. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 20_000 };

export type ClassifiedError = {
  kind: ErrorKind;
  retryable: boolean;
  status?: number;
  /** Server-provided delay hint (retry-after / retry-after-ms), when present. */
  retryAfterMs?: number;
  message: string;
};

function retryAfterMs(error: APIError): number | undefined {
  const headers = error.headers;
  if (!headers) {
    return undefined;
  }
  const ms = headers.get("retry-after-ms");
  if (ms && Number.isFinite(Number(ms))) {
    return Math.max(0, Number(ms));
  }
  const seconds = headers.get("retry-after");
  if (seconds && Number.isFinite(Number(seconds))) {
    return Math.max(0, Number(seconds) * 1000);
  }
  return undefined;
}

/**
 * Map SDK errors to a retry decision using the SDK's typed classes (never message matching).
 * Retryable: 408, 409, 429, >= 500 (including 529 overloaded), connection failures and timeouts.
 * Not retryable: other 4xx (bad request, auth, permission, not found) and caller aborts.
 */
export function classifyModelError(error: unknown): ClassifiedError {
  if (error instanceof APIUserAbortError) {
    return { kind: "aborted", retryable: false, message: "Request aborted" };
  }
  if (error instanceof APIConnectionTimeoutError) {
    return { kind: "timeout", retryable: true, message: error.message };
  }
  if (error instanceof APIConnectionError) {
    return { kind: "connection", retryable: true, message: error.message };
  }
  if (error instanceof RateLimitError) {
    return { kind: "rate_limit", retryable: true, status: 429, retryAfterMs: retryAfterMs(error), message: error.message };
  }
  if (error instanceof InternalServerError) {
    const status = error.status;
    return {
      kind: status === 529 ? "overloaded" : "server",
      retryable: true,
      status,
      retryAfterMs: retryAfterMs(error),
      message: error.message,
    };
  }
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
    return { kind: "auth", retryable: false, status: error.status, message: error.message };
  }
  if (error instanceof NotFoundError) {
    return { kind: "not_found", retryable: false, status: 404, message: error.message };
  }
  if (error instanceof BadRequestError) {
    return { kind: "bad_request", retryable: false, status: 400, message: error.message };
  }
  if (error instanceof APIError) {
    const status = typeof error.status === "number" ? error.status : undefined;
    const retryable = status === 408 || status === 409 || (status !== undefined && status >= 500);
    return { kind: retryable ? "server" : "unknown", retryable, status, retryAfterMs: retryAfterMs(error), message: error.message };
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { kind: "aborted", retryable: false, message: "Request aborted" };
  }
  return { kind: "unknown", retryable: false, message: error instanceof Error ? error.message : String(error) };
}

/**
 * Exponential backoff with full jitter (AWS architecture blog): uniform in [0, min(cap, base·2^n)].
 * A server retry-after hint, when larger, is honoured instead.
 */
export function backoffDelayMs(
  attempt: number,
  policy: RetryPolicy,
  hintMs: number | undefined,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.floor(random() * ceiling);
  return hintMs !== undefined ? Math.min(policy.maxDelayMs, Math.max(jittered, hintMs)) : jittered;
}

/** Sleep that rejects promptly when the signal aborts, so a deadline also cancels backoff waits. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
