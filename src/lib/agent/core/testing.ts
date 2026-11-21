import type {
  BetaContentBlock,
  BetaMessage,
  BetaTextBlock,
  BetaToolUseBlock,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

/**
 * Offline transport for the real SDK: a fetch implementation that answers POST /v1/messages from a
 * responder function. Tests, the offline demo policy and the evaluation baselines use it, so the
 * SDK Tool Runner itself is exercised end to end without network access or an API key.
 */

let counter = 0;
const nextId = (prefix: string) => `${prefix}_${(++counter).toString(36).padStart(6, "0")}`;

export function textBlock(text: string): BetaTextBlock {
  return { type: "text", text, citations: null } as BetaTextBlock;
}

export function toolUseBlock(name: string, input: unknown, id: string = nextId("toolu")): BetaToolUseBlock {
  return { type: "tool_use", id, name, input } as BetaToolUseBlock;
}

export function assistantMessage(
  content: BetaContentBlock[],
  options: {
    stopReason?: BetaMessage["stop_reason"];
    model?: string;
    usage?: Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number }>;
  } = {},
): BetaMessage {
  const stopReason = options.stopReason ?? (content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn");
  return {
    id: nextId("msg"),
    type: "message",
    role: "assistant",
    model: options.model ?? "scripted-model",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    diagnostics: null,
    usage: {
      input_tokens: options.usage?.input ?? 100,
      output_tokens: options.usage?.output ?? 20,
      cache_read_input_tokens: options.usage?.cacheRead ?? 0,
      cache_creation_input_tokens: options.usage?.cacheWrite ?? 0,
      cache_creation: null,
      inference_geo: null,
      iterations: null,
      server_tool_use: null,
      service_tier: null,
      fallback_credit: null,
    },
  } as unknown as BetaMessage;
}

/** An HTTP error response the SDK will classify (and retry when retryable). */
export type ScriptedHttpError = { httpStatus: number; errorType: string; message?: string; headers?: Record<string, string> };

export type MessagesRequest = MessageCreateParamsNonStreaming & { betas?: string[] };
export type Responder = (request: MessagesRequest, callIndex: number) => BetaMessage | ScriptedHttpError | Promise<BetaMessage | ScriptedHttpError>;

export function httpError(httpStatus: number, errorType: string, headers?: Record<string, string>): ScriptedHttpError {
  return { httpStatus, errorType, headers };
}

/** A fetch that serves the Messages API from `responder` and records every request body. */
export function scriptedFetch(responder: Responder): { fetch: typeof globalThis.fetch; requests: MessagesRequest[] } {
  const requests: MessagesRequest[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.endsWith("/v1/messages") && !url.includes("/v1/messages?")) {
      return new Response(JSON.stringify({ type: "error", error: { type: "not_found_error", message: url } }), { status: 404 });
    }
    const signal = init?.signal;
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as MessagesRequest;
    requests.push(body);
    const result = await responder(body, requests.length - 1);
    if ("httpStatus" in result) {
      return new Response(JSON.stringify({ type: "error", error: { type: result.errorType, message: result.message ?? result.errorType } }), {
        status: result.httpStatus,
        headers: { "content-type": "application/json", ...(result.headers ?? {}) },
      });
    }
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json", "request-id": nextId("req") },
    });
  };
  return { fetch: fetchImpl, requests };
}

/** Responder that replays a fixed list; each entry may be a function of the request. */
export function scriptResponder(
  steps: Array<BetaMessage | ScriptedHttpError | ((request: MessagesRequest) => BetaMessage | ScriptedHttpError)>,
): Responder {
  return (request, index) => {
    const step = steps[index];
    if (step === undefined) {
      throw new Error(`script exhausted after ${index} calls`);
    }
    return typeof step === "function" ? step(request) : step;
  };
}
