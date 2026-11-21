import type {
  BetaContentBlock,
  BetaMessage,
  BetaTextBlock,
  BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { ModelClient, ModelRequest } from "./types";

/**
 * Builders for SDK-shaped fixtures and a scripted ModelClient. Used by unit tests and by the
 * offline evaluation baselines so they drive the real loop, not a re-implementation of it.
 */

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter.toString(36).padStart(6, "0")}`;
}

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
  const stopReason =
    options.stopReason ?? (content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn");
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

export type ScriptStep = BetaMessage | Error | ((request: ModelRequest, callIndex: number) => BetaMessage | Error);

/** Replays a fixed script of responses (or thrown errors). Records every request it receives. */
export class ScriptedModelClient implements ModelClient {
  readonly provider = "scripted";
  readonly requests: ModelRequest[] = [];
  private index = 0;

  constructor(private readonly script: ScriptStep[]) {}

  async createMessage(request: ModelRequest, options: { signal: AbortSignal }): Promise<BetaMessage> {
    if (options.signal.aborted) {
      throw options.signal.reason;
    }
    this.requests.push(request);
    const step = this.script[this.index];
    const callIndex = this.index;
    this.index += 1;
    if (step === undefined) {
      throw new Error(`ScriptedModelClient exhausted after ${callIndex} calls`);
    }
    const resolved = typeof step === "function" ? step(request, callIndex) : step;
    if (resolved instanceof Error) {
      throw resolved;
    }
    return resolved;
  }

  get callCount(): number {
    return this.index;
  }
}
