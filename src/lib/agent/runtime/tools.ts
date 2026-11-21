import { z } from "zod";
import { transformJSONSchema } from "@anthropic-ai/sdk/lib/transform-json-schema";
import type { BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";

/**
 * A tool the loop can offer the model. Input is validated with zod before `execute` runs — the
 * model's arguments are untrusted output even when `strict` constrains the schema server-side.
 */
export type AgentTool<Context, Input = unknown> = {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  /**
   * "read" tools may run concurrently within one model turn. "write" tools run sequentially, in the
   * order the model emitted them, after all reads of that turn.
   */
  effect: "read" | "write";
  /** A terminal tool ends the loop: its validated input is the run's submission. */
  terminal?: boolean;
  /** Send `strict: true` so the API guarantees schema-valid arguments. Default true. */
  strict?: boolean;
  execute(input: Input, context: ToolCallContext<Context>): Promise<ToolResult>;
};

export type ToolCallContext<Context> = {
  context: Context;
  step: number;
  toolUseId: string;
  signal: AbortSignal;
};

/** What a tool hands back. `content` is serialised to JSON for the model. */
export type ToolResult =
  | { ok: true; content: unknown }
  | { ok: false; errorCode: string; message: string };

/** Error a tool can throw to report a model-actionable problem (bad id, not permitted, …). */
export class ToolInputError extends Error {
  constructor(
    readonly errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolInputError";
  }
}

/** Erase the input type so heterogeneous tools fit one registry. Validation restores it at runtime. */
export function defineTool<Context, Input>(tool: AgentTool<Context, Input>): AgentTool<Context, unknown> {
  return tool as AgentTool<Context, unknown>;
}

function jsonSchemaFor(schema: z.ZodType, strict: boolean): BetaTool["input_schema"] {
  const raw = z.toJSONSchema(schema, { reused: "ref" }) as Record<string, unknown>;
  // Same transform the SDK applies for structured outputs: constraints the strict grammar does not
  // support (min/max lengths, numeric bounds) move into descriptions; zod still enforces them.
  const transformed = strict ? transformJSONSchema(raw) : { ...raw };
  delete (transformed as Record<string, unknown>).$schema;
  return transformed as BetaTool["input_schema"];
}

/** API tool definitions, in a stable order (tool definitions are part of the cached prefix). */
export function toApiTools<Context>(tools: ReadonlyArray<AgentTool<Context>>): BetaTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: jsonSchemaFor(tool.inputSchema, tool.strict !== false),
    ...(tool.strict !== false ? { strict: true } : {}),
  }));
}

export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}
