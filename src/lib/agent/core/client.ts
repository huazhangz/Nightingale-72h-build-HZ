import Anthropic from "@anthropic-ai/sdk";

export type ClientOptions = {
  /** Defaults to the SDK's own credential resolution (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, profile). */
  apiKey?: string;
  baseURL?: string;
  timeoutMs?: number;
  /** SDK-managed retries for 408/409/429/5xx and connection errors (exponential backoff). */
  maxRetries?: number;
  /** Replace the transport (tests and offline evaluation use a scripted fetch). */
  fetch?: typeof globalThis.fetch;
  /** Observe every HTTP response status (retried failures included) for the run trace. */
  onResponseStatus?: (status: number) => void;
};

/**
 * One Anthropic client per agent run. Construction is cheap, and a per-run client lets the
 * transport report retried HTTP failures into that run's trace without global state.
 */
export function createAnthropicClient(options: ClientOptions = {}): Anthropic {
  const base = options.fetch ?? globalThis.fetch;
  const observe = options.onResponseStatus;
  const transport: typeof globalThis.fetch = observe
    ? async (input, init) => {
        const response = await base(input, init);
        observe(response.status);
        return response;
      }
    : base;
  return new Anthropic({
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    maxRetries: options.maxRetries ?? 3,
    timeout: options.timeoutMs ?? 120_000,
    fetch: transport,
  });
}

/** Factory signature agents accept, so callers decide transport and credentials. */
export type ClientFactory = (hooks: { onResponseStatus: (status: number) => void }) => Anthropic;
