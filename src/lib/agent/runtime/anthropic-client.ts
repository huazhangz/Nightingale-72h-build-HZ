import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { ModelClient, ModelRequest } from "./types";

export type AnthropicClientOptions = {
  /** Defaults to the SDK's own resolution (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, `ant` profile). */
  apiKey?: string;
  baseURL?: string;
  /** Per-request HTTP timeout. The loop's deadline is the overall ceiling. */
  timeoutMs?: number;
};

/**
 * Messages API client for the loop. SDK retries are disabled (`maxRetries: 0`): the loop owns retry
 * policy so every attempt, backoff and error class is recorded in the run trace.
 */
export class AnthropicModelClient implements ModelClient {
  readonly provider = "anthropic";
  private readonly client: Anthropic;

  constructor(options: AnthropicClientOptions = {}) {
    this.client = new Anthropic({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      maxRetries: 0,
      timeout: options.timeoutMs ?? 120_000,
    });
  }

  createMessage(request: ModelRequest, options: { signal: AbortSignal }): Promise<BetaMessage> {
    return this.client.beta.messages.create({ ...request, stream: false }, { signal: options.signal });
  }
}
