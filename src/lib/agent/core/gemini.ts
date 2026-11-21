import type { BetaContentBlock, BetaMessage, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { MessagesRequest } from "./testing";

/**
 * Google Gemini as a transport for the Anthropic SDK client.
 *
 * The agents are written once against the Anthropic SDK Tool Runner. This adapter is a `fetch`
 * implementation that accepts Messages API requests, calls Gemini `generateContent`, and answers
 * with Messages API responses, so the production path (Tool Runner, tool validation, budgets,
 * outcome taxonomy, guardrails, floors, evaluations) runs unchanged on a second provider.
 *
 * Mapping:
 *   system                  → systemInstruction
 *   user / assistant        → user / model contents (adjacent turns of one role merged)
 *   tool_use / tool_result  → functionCall / functionResponse (names resolved from tool_use ids)
 *   tools[].input_schema    → functionDeclarations[].parameters ($ref inlined, OpenAPI subset)
 *   max_tokens              → generationConfig.maxOutputTokens
 *   finishReason            → stop_reason (function call → tool_use, MAX_TOKENS → max_tokens,
 *                             safety / blocked → refusal, anything else → end_turn)
 *   usageMetadata           → usage (thinking tokens count as output, cached tokens as cache reads)
 *   HTTP errors             → Anthropic error bodies with the same status; Gemini RetryInfo
 *                             becomes `retry-after`, so the SDK's retry policy applies
 *
 * Gemini "thought signatures" on function calls must be sent back with the call in later turns.
 * They are kept per client instance (one per agent run), keyed by tool_use id.
 *
 * Ignored request fields: cache_control, output_config.effort, fallbacks and betas (Anthropic
 * features with no direct Gemini equivalent), and `strict` (tool inputs are validated again by the
 * tool layer, which returns INVALID_INPUT errors the model can correct).
 */

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

type JsonSchema = Record<string, unknown>;

export type GeminiPart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
};

export type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

export type GeminiRequest = {
  systemInstruction?: { parts: Array<{ text: string }> };
  contents: GeminiContent[];
  tools?: Array<{ functionDeclarations: Array<{ name: string; description?: string; parameters?: JsonSchema }> }>;
  generationConfig?: { maxOutputTokens?: number };
};

export type GeminiResponse = {
  candidates?: Array<{ content?: { role?: string; parts?: GeminiPart[] }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  modelVersion?: string;
  responseId?: string;
};

/** Keys of JSON Schema that Gemini function declarations accept (OpenAPI 3.0 subset). */
const SCHEMA_KEYS = new Set([
  "type",
  "description",
  "properties",
  "required",
  "items",
  "enum",
  "format",
  "nullable",
  "anyOf",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "propertyOrdering",
]);

/**
 * Convert a tool's JSON Schema to the subset Gemini accepts: local `$ref`s are inlined (the tool
 * schemas are not recursive), `$defs`, `additionalProperties` and other unsupported keywords are
 * dropped, and string enums get an explicit `type`.
 */
export function toGeminiSchema(schema: JsonSchema, defs: Record<string, JsonSchema> = (schema.$defs as Record<string, JsonSchema>) ?? {}, depth = 0): JsonSchema {
  if (depth > 32) {
    throw new Error("Tool schema is too deep or recursive for Gemini function declarations");
  }
  const ref = schema.$ref;
  if (typeof ref === "string") {
    const target = defs[ref.replace(/^#\/\$defs\//, "")];
    if (!target) {
      throw new Error(`Unresolvable schema reference ${ref}`);
    }
    const { $ref: _ignored, ...rest } = schema;
    return toGeminiSchema({ ...target, ...rest }, defs, depth + 1);
  }
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!SCHEMA_KEYS.has(key)) {
      continue;
    }
    if (key === "properties" && value && typeof value === "object") {
      out.properties = Object.fromEntries(
        Object.entries(value as Record<string, JsonSchema>).map(([name, child]) => [name, toGeminiSchema(child, defs, depth + 1)]),
      );
    } else if (key === "items" && value && typeof value === "object") {
      out.items = toGeminiSchema(value as JsonSchema, defs, depth + 1);
    } else if (key === "anyOf" && Array.isArray(value)) {
      out.anyOf = value.map((child) => toGeminiSchema(child as JsonSchema, defs, depth + 1));
    } else {
      out[key] = value;
    }
  }
  if (Array.isArray(out.enum) && out.type === undefined && out.enum.every((item) => typeof item === "string")) {
    out.type = "string";
  }
  return out;
}

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

function parsedOrText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Synthetic tool_use ids are ours; ids Gemini returned are sent back as function call ids. */
const SYNTHETIC_ID = /^toolu_gm_/;

export function toGeminiRequest(request: MessagesRequest, signatures: ReadonlyMap<string, string>): GeminiRequest {
  const toolNames = new Map<string, string>();
  const contents: GeminiContent[] = [];
  const push = (role: GeminiContent["role"], parts: GeminiPart[]) => {
    if (parts.length === 0) {
      return;
    }
    const last = contents.at(-1);
    if (last && last.role === role) {
      last.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  };

  for (const message of request.messages as BetaMessageParam[]) {
    const role = message.role === "assistant" ? "model" : "user";
    if (typeof message.content === "string") {
      push(role, message.content ? [{ text: message.content }] : []);
      continue;
    }
    const parts: GeminiPart[] = [];
    for (const block of message.content as Array<Record<string, unknown> & { type: string }>) {
      if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
        parts.push({ text: block.text });
      } else if (block.type === "tool_use") {
        const id = String(block.id);
        const name = String(block.name);
        toolNames.set(id, name);
        const signature = signatures.get(id);
        parts.push({
          functionCall: { ...(SYNTHETIC_ID.test(id) ? {} : { id }), name, args: (block.input as Record<string, unknown>) ?? {} },
          ...(signature ? { thoughtSignature: signature } : {}),
        });
      } else if (block.type === "tool_result") {
        const id = String(block.tool_use_id);
        const value = parsedOrText(textOf(block.content));
        parts.push({
          functionResponse: {
            ...(SYNTHETIC_ID.test(id) ? {} : { id }),
            name: toolNames.get(id) ?? "unknown_tool",
            response: block.is_error ? { error: value } : { result: value },
          },
        });
      }
      // thinking / redacted_thinking / other block types have no Gemini equivalent and are dropped.
    }
    push(role, parts);
  }

  const system = typeof request.system === "string" ? request.system : textOf(request.system);
  const tools = (request.tools ?? []) as Array<{ name: string; description?: string; input_schema?: JsonSchema }>;
  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents,
    ...(tools.length
      ? {
          tools: [
            {
              functionDeclarations: tools.map((tool) => ({
                name: tool.name,
                ...(tool.description ? { description: tool.description } : {}),
                ...(tool.input_schema && Object.keys((tool.input_schema.properties as object) ?? {}).length > 0
                  ? { parameters: toGeminiSchema(tool.input_schema) }
                  : {}),
              })),
            },
          ],
        }
      : {}),
    ...(request.max_tokens ? { generationConfig: { maxOutputTokens: request.max_tokens } } : {}),
  };
}

const REFUSAL_REASONS = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"]);

export function fromGeminiResponse(
  response: GeminiResponse,
  requestedModel: string,
  signatures: Map<string, string>,
  nextId: () => string,
): BetaMessage {
  const candidate = response.candidates?.[0];
  const content: BetaContentBlock[] = [];
  let hasToolUse = false;
  for (const part of candidate?.content?.parts ?? []) {
    if (part.thought) {
      continue;
    }
    if (part.functionCall) {
      const id = part.functionCall.id ?? `toolu_gm_${nextId()}`;
      if (part.thoughtSignature) {
        signatures.set(id, part.thoughtSignature);
      }
      hasToolUse = true;
      content.push({ type: "tool_use", id, name: part.functionCall.name, input: part.functionCall.args ?? {} } as BetaContentBlock);
    } else if (typeof part.text === "string" && part.text.length > 0) {
      const last = content.at(-1);
      if (last && last.type === "text") {
        (last as { text: string }).text += part.text;
      } else {
        content.push({ type: "text", text: part.text, citations: null } as BetaContentBlock);
      }
    }
  }

  const finish = candidate?.finishReason;
  let stopReason: BetaMessage["stop_reason"];
  if (!candidate) {
    stopReason = response.promptFeedback?.blockReason ? "refusal" : "end_turn";
  } else if (finish === "MAX_TOKENS") {
    stopReason = "max_tokens";
  } else if (finish && REFUSAL_REASONS.has(finish)) {
    stopReason = "refusal";
  } else if (hasToolUse) {
    stopReason = "tool_use";
  } else {
    stopReason = "end_turn";
  }
  if (content.length === 0 && (finish === "MALFORMED_FUNCTION_CALL" || finish === "UNEXPECTED_TOOL_CALL")) {
    content.push({ type: "text", text: `(The model produced an invalid function call: ${finish}.)`, citations: null } as BetaContentBlock);
  }

  const usage = response.usageMetadata ?? {};
  const cached = usage.cachedContentTokenCount ?? 0;
  return {
    id: response.responseId ? `msg_gm_${response.responseId}` : `msg_gm_${nextId()}`,
    type: "message",
    role: "assistant",
    model: response.modelVersion ?? requestedModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: Math.max(0, (usage.promptTokenCount ?? 0) - cached),
      output_tokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
    },
  } as unknown as BetaMessage;
}

const ERROR_TYPES: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  413: "request_too_large",
  429: "rate_limit_error",
  500: "api_error",
  503: "overloaded_error",
};

/** Gemini error → Anthropic-shaped error response (same status, retry-after from RetryInfo). */
export function geminiErrorResponse(status: number, body: string): Response {
  let message = `Gemini API error ${status}`;
  let retryAfter: string | null = null;
  try {
    // Native endpoints answer {error: {...}}; the OpenAI-compatible endpoint may answer [{error: {...}}].
    const raw = JSON.parse(body) as unknown;
    const first = (Array.isArray(raw) ? raw[0] : raw) as { error?: { message?: string; status?: string; details?: Array<Record<string, unknown>> } };
    const error = first?.error;
    if (error) {
      message = `${error.status ?? status}: ${error.message ?? ""}`.trim();
      const retry = error.details?.find((detail) => typeof detail.retryDelay === "string")?.retryDelay as string | undefined;
      const seconds = retry ? Number.parseFloat(retry) : Number.NaN;
      if (Number.isFinite(seconds) && seconds > 0) {
        retryAfter = String(Math.ceil(seconds));
      }
    }
  } catch {
    // Non-JSON error body: keep the generic message.
  }
  return new Response(JSON.stringify({ type: "error", error: { type: ERROR_TYPES[status] ?? "api_error", message: message.slice(0, 500) } }), {
    status,
    headers: { "content-type": "application/json", ...(retryAfter ? { "retry-after": retryAfter } : {}) },
  });
}

let nextSlotAt = 0;

/** Space requests at least `intervalMs` apart across all Gemini clients in this process (free-tier RPM). */
export async function waitForSlot(intervalMs: number, signal?: AbortSignal | null): Promise<void> {
  if (intervalMs <= 0) {
    return;
  }
  const now = Date.now();
  const at = Math.max(now, nextSlotAt);
  nextSlotAt = at + intervalMs;
  const wait = at - now;
  if (wait <= 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, wait);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

export type GeminiFetchOptions = {
  apiKey: string;
  baseURL?: string;
  /** Minimum spacing between requests (process-wide), for free-tier requests-per-minute limits. */
  minIntervalMs?: number;
  /** Underlying transport (tests pass a scripted Gemini server). */
  fetch?: typeof globalThis.fetch;
};

/** A `fetch` for the Anthropic SDK client that serves the Messages API from Gemini. */
export function geminiFetch(options: GeminiFetchOptions): typeof globalThis.fetch {
  const base = (options.baseURL ?? GEMINI_BASE_URL).replace(/\/$/, "");
  const upstream = options.fetch ?? globalThis.fetch;
  const signatures = new Map<string, string>();
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
    const body = toGeminiRequest(request, signatures);
    await waitForSlot(options.minIntervalMs ?? 0, init?.signal);
    const response = await upstream(`${base}/models/${encodeURIComponent(request.model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": options.apiKey },
      body: JSON.stringify(body),
      signal: init?.signal ?? null,
    });
    const text = await response.text();
    if (!response.ok) {
      return geminiErrorResponse(response.status, text);
    }
    const message = fromGeminiResponse(JSON.parse(text) as GeminiResponse, request.model, signatures, nextId);
    return new Response(JSON.stringify(message), { status: 200, headers: { "content-type": "application/json", "request-id": message.id } });
  };
}
