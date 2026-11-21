import { z } from "zod";
import { transformJSONSchema } from "@anthropic-ai/sdk/lib/transform-json-schema";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import type { BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { TraceEvent } from "./types";

/**
 * Agent tool definition: a zod schema (single source of truth for validation and the strict JSON
 * Schema sent to the API) plus a `run` bound to a per-run context. `bindTools` turns definitions into
 * SDK runnable tools for `client.beta.messages.toolRunner`.
 */
export type AgentTool<Context, Input = unknown> = {
  name: string;
  description: string;
  schema: z.ZodType<Input>;
  /** A terminal tool ends the run; its validated input is the run's result. It is never executed. */
  terminal?: boolean;
  run(input: Input, context: { context: Context; signal?: AbortSignal | null }): Promise<unknown>;
};

/** A model-actionable tool failure (unknown id, not permitted, …). Its message is shown to the model. */
export class ToolInputError extends Error {
  constructor(
    readonly errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolInputError";
  }
}

export function defineTool<Context, Input>(tool: AgentTool<Context, Input>): AgentTool<Context, unknown> {
  return tool as AgentTool<Context, unknown>;
}

/** Tool results above this size are refused: tools must page rather than flood the context. */
export const MAX_TOOL_RESULT_CHARS = 100_000;

function errorPayload(code: string, message: string): string {
  return JSON.stringify({ error: { code, message } });
}

export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}

/** Strict-mode compatible JSON Schema (unsupported constraints move into descriptions; zod still enforces them). */
export function toInputSchema(schema: z.ZodType): BetaTool["input_schema"] {
  const transformed = transformJSONSchema(z.toJSONSchema(schema, { reused: "ref" }) as Record<string, unknown>);
  delete (transformed as Record<string, unknown>).$schema;
  return transformed as BetaTool["input_schema"];
}

/**
 * Bind definitions to one run. Every failure becomes a structured `is_error` result with a safe
 * message: unexpected exceptions never reach the model verbatim (the SDK would otherwise send
 * "Error: <internal message>").
 */
export function bindTools<Context>(
  tools: ReadonlyArray<AgentTool<Context>>,
  context: Context,
  trace: TraceEvent[],
): BetaRunnableTool<unknown>[] {
  return tools.map((tool) => {
    const record = (event: Omit<Extract<TraceEvent, { type: "tool_call" }>, "type" | "name">) =>
      trace.push({ type: "tool_call", name: tool.name, ...event });
    return {
      name: tool.name,
      description: tool.description,
      input_schema: toInputSchema(tool.schema),
      strict: true,
      parse(input: unknown) {
        const parsed = tool.schema.safeParse(input);
        if (!parsed.success) {
          const message = formatZodIssues(parsed.error);
          record({ ok: false, errorCode: "INVALID_INPUT", durationMs: 0, inputBytes: JSON.stringify(input ?? null).length, outputBytes: message.length });
          throw new ToolError(errorPayload("INVALID_INPUT", message));
        }
        return parsed.data;
      },
      async run(input: unknown, runContext) {
        const started = Date.now();
        const inputBytes = JSON.stringify(input ?? null).length;
        if (tool.terminal) {
          // Reached only when the terminal call shared a turn with other calls: the submission was
          // written before the model could read their results.
          const message = `${tool.name} must be called alone, after you have read the results of your other tool calls.`;
          record({ ok: false, errorCode: "TERMINAL_NOT_ALONE", durationMs: 0, inputBytes, outputBytes: message.length });
          throw new ToolError(errorPayload("TERMINAL_NOT_ALONE", message));
        }
        try {
          const result = await tool.run(input, { context, signal: runContext?.signal });
          const text = typeof result === "string" ? result : JSON.stringify(result);
          if (text.length > MAX_TOOL_RESULT_CHARS) {
            throw new ToolInputError("RESULT_TOO_LARGE", "Result too large; request fewer items.");
          }
          record({ ok: true, durationMs: Date.now() - started, inputBytes, outputBytes: text.length });
          return text;
        } catch (error) {
          const code = error instanceof ToolInputError ? error.errorCode : "TOOL_FAILED";
          const message = error instanceof ToolInputError ? error.message : "The tool failed unexpectedly.";
          record({ ok: false, errorCode: code, durationMs: Date.now() - started, inputBytes, outputBytes: message.length });
          throw new ToolError(errorPayload(code, message));
        }
      },
    } satisfies BetaRunnableTool<unknown>;
  });
}
