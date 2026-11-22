import type { BetaContentBlock, BetaMessage, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { geminiErrorResponse, toGeminiSchema } from "./gemini";
import type { MessagesRequest } from "./testing";

/**
 * OpenAI Chat Completions as a transport for the Anthropic SDK client, used for Gemini's
 * OpenAI-compatible endpoint (`…/v1beta/openai/chat/completions`), which accepts the API key as
 * `Authorization: Bearer` (the native endpoint only takes `x-goog-api-key`). Same contract as the
 * native adapter in gemini.ts: Messages API in, Messages API out, so the Tool Runner, tools,
 * guardrails, floors and evaluations run unchanged.
 *
 * Mapping:
 *   system                          → a system message
 *   assistant text / tool_use       → assistant content / tool_calls (arguments as JSON text)
 *   tool_result                     → one `tool` message per result, right after its call
 *   tools[].input_schema            → tools[].function.parameters ($ref inlined)
 *   output_config.effort            → reasoning_effort (low | medium | high)
 *   finish_reason                   → stop_reason (tool_calls → tool_use, length → max_tokens,
 *                                     content_filter → refusal, otherwise end_turn)
 *   usage                           → output = total − prompt, so thinking tokens (reported only in
 *                                     the total) are counted; cached prompt tokens as cache reads
 * Gemini 3 thought signatures arrive as `extra_content` on tool calls and are sent back with them.
 */

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string }; extra_content?: unknown }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: Array<{ type: "function"; function: { name: string; description?: string; parameters?: Record<string, unknown> } }>;
  max_tokens?: number;
  reasoning_effort?: "low" | "medium" | "high";
};

export type ChatResponse = {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string }; extra_content?: unknown }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
};

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === "object" && (block as { type?: string }).type === "text" ? (block as { text: string }).text : ""))
      .join("");
  }
  return "";
}

const EFFORT: Record<string, ChatRequest["reasoning_effort"]> = { low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" };

export function toChatRequest(request: MessagesRequest, extras: ReadonlyMap<string, unknown>): ChatRequest {
  const messages: ChatMessage[] = [];
  const system = typeof request.system === "string" ? request.system : textOf(request.system);
  if (system) {
    messages.push({ role: "system", content: system });
  }
  for (const message of request.messages as BetaMessageParam[]) {
    if (typeof message.content === "string") {
      messages.push(message.role === "assistant" ? { role: "assistant", content: message.content } : { role: "user", content: message.content });
      continue;
    }
    const blocks = message.content as Array<Record<string, unknown> & { type: string }>;
    if (message.role === "assistant") {
      const text = blocks.filter((block) => block.type === "text").map((block) => String(block.text)).join("");
      const calls = blocks
        .filter((block) => block.type === "tool_use")
        .map((block) => {
          const id = String(block.id);
          const extra = extras.get(id);
          return {
            id,
            type: "function" as const,
            function: { name: String(block.name), arguments: JSON.stringify(block.input ?? {}) },
            ...(extra !== undefined ? { extra_content: extra } : {}),
          };
        });
      if (text || calls.length) {
        messages.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      }
      continue;
    }
    // User turn: tool results first (they must follow the assistant's calls), then any text.
    for (const block of blocks) {
      if (block.type === "tool_result") {
        const content = textOf(block.content);
        messages.push({ role: "tool", tool_call_id: String(block.tool_use_id), content: block.is_error ? JSON.stringify({ error: content }) : content });
      }
    }
    const text = blocks.filter((block) => block.type === "text").map((block) => String(block.text)).join("\n");
    if (text) {
      messages.push({ role: "user", content: text });
    }
  }

  const tools = (request.tools ?? []) as Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>;
  const effort = (request as { output_config?: { effort?: string } }).output_config?.effort;
  return {
    model: request.model,
    messages,
    ...(tools.length
      ? {
          tools: tools.map((tool) => ({
            type: "function" as const,
            function: {
              name: tool.name,
              ...(tool.description ? { description: tool.description } : {}),
              ...(tool.input_schema && Object.keys((tool.input_schema.properties as object) ?? {}).length > 0
                ? { parameters: toGeminiSchema(tool.input_schema) }
                : {}),
            },
          })),
        }
      : {}),
    ...(request.max_tokens ? { max_tokens: request.max_tokens } : {}),
    ...(effort && EFFORT[effort] ? { reasoning_effort: EFFORT[effort] } : {}),
  };
}

export function fromChatResponse(response: ChatResponse, requestedModel: string, extras: Map<string, unknown>, nextId: () => string): BetaMessage {
  const choice = response.choices?.[0];
  const content: BetaContentBlock[] = [];
  const text = choice?.message?.content;
  if (typeof text === "string" && text.length > 0) {
    content.push({ type: "text", text, citations: null } as BetaContentBlock);
  }
  for (const call of choice?.message?.tool_calls ?? []) {
    const id = call.id || `toolu_oc_${nextId()}`;
    if (call.extra_content !== undefined) {
      extras.set(id, call.extra_content);
    }
    let input: unknown;
    try {
      input = JSON.parse(call.function?.arguments || "{}");
    } catch {
      // Let the tool layer reject it with INVALID_INPUT so the model can correct itself.
      input = { unparsable_arguments: String(call.function?.arguments ?? "") };
    }
    content.push({ type: "tool_use", id, name: call.function?.name ?? "unknown_tool", input } as BetaContentBlock);
  }

  const finish = choice?.finish_reason;
  // Gemini's compatibility layer reports a function call it could not parse as an empty message with
  // finish_reason "function_call_filter: MALFORMED_FUNCTION_CALL". Say so, so the history (and the
  // runner's reminder) tells the model its call was not executed, instead of an empty turn.
  if (content.length === 0 && typeof finish === "string" && finish.includes("MALFORMED_FUNCTION_CALL")) {
    content.push({ type: "text", text: "(My previous function call was malformed JSON and was not executed.)", citations: null } as BetaContentBlock);
  }
  const hasToolUse = content.some((block) => block.type === "tool_use");
  const stopReason: BetaMessage["stop_reason"] =
    finish === "length" ? "max_tokens" : finish === "content_filter" ? "refusal" : hasToolUse ? "tool_use" : "end_turn";

  const usage = response.usage ?? {};
  const prompt = usage.prompt_tokens ?? 0;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const output = Math.max(usage.completion_tokens ?? 0, (usage.total_tokens ?? 0) - prompt);
  return {
    id: response.id ? `msg_oc_${response.id}` : `msg_oc_${nextId()}`,
    type: "message",
    role: "assistant",
    model: response.model ?? requestedModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: Math.max(0, prompt - cached), output_tokens: output, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 },
  } as unknown as BetaMessage;
}

export type OpenAICompatOptions = {
  /** Chat Completions base, e.g. https://generativelanguage.googleapis.com/v1beta/openai */
  baseURL: string;
  /** Sent as `Authorization: Bearer`; a placeholder when a network proxy injects the real key. */
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  /** Called before each upstream request (rate spacing, spend caps). */
  beforeRequest?: (signal?: AbortSignal | null) => Promise<void>;
};

export function openAICompatFetch(options: OpenAICompatOptions): typeof globalThis.fetch {
  const base = options.baseURL.replace(/\/$/, "");
  const upstream = options.fetch ?? globalThis.fetch;
  const extras = new Map<string, unknown>();
  let counter = 0;
  const nextId = () => `${Date.now().toString(36)}${(counter += 1).toString(36)}`;

  return async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.endsWith("/v1/messages") && !url.includes("/v1/messages?")) {
      return new Response(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "Only the Messages API is adapted" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const request = JSON.parse(String(init?.body ?? "{}")) as MessagesRequest;
    await options.beforeRequest?.(init?.signal);
    const response = await upstream(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify(toChatRequest(request, extras)),
      signal: init?.signal ?? null,
    });
    const text = await response.text();
    if (!response.ok) {
      return geminiErrorResponse(response.status, text);
    }
    const message = fromChatResponse(JSON.parse(text) as ChatResponse, request.model, extras, nextId);
    return new Response(JSON.stringify(message), { status: 200, headers: { "content-type": "application/json", "request-id": message.id } });
  };
}
