import type { Prisma, Role } from "@prisma/client";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { prisma } from "../../db";
import type { ClientFactory } from "../core/client";
import { runToolAgent, type RunAgentConfig, type RunAgentResult } from "../core/run-agent";
import type { AgentTool } from "../core/tool";
import type { TraceEvent } from "../core/types";

/**
 * Runs one agent on the SDK Tool Runner and records it as an AgentRun: created RUNNING before the
 * first model call, finished with outcome, usage and a metadata-only trace. Agent-specific code
 * supplies tools, prompt, context and the post-processing of the submission.
 */
export type ExecuteAgentInput<Context> = {
  agent: string;
  clinicId: string;
  patientId: string;
  actor: { id: string; role: Role };
  promptVersion: string;
  promptHash: string;
  clientFactory: ClientFactory;
  config: RunAgentConfig;
  tools: ReadonlyArray<AgentTool<Context>>;
  context: Context;
  messages: BetaMessageParam[];
  signal?: AbortSignal;
};

export type ExecutedAgent = { runId: string; result: RunAgentResult };

export async function executeAgent<Context>(input: ExecuteAgentInput<Context>): Promise<ExecutedAgent> {
  const run = await prisma.agentRun.create({
    data: {
      agent: input.agent,
      clinicId: input.clinicId,
      patientId: input.patientId,
      actorId: input.actor.id,
      actorRole: input.actor.role,
      promptVersion: input.promptVersion,
      promptHash: input.promptHash,
      model: input.config.model,
    },
  });
  const trace: TraceEvent[] = [];
  const client = input.clientFactory({
    onResponseStatus: (status) => {
      if (status >= 400) {
        trace.push({ type: "http_retry", status });
      }
    },
  });
  const result = await runToolAgent({
    client,
    config: input.config,
    tools: input.tools,
    context: input.context,
    messages: input.messages,
    trace,
    signal: input.signal,
  });
  return { runId: run.id, result };
}

export async function finishAgentRun(
  runId: string,
  result: RunAgentResult,
  extra: { status: "SUCCEEDED" | "FAILED"; summary?: unknown; guardrail?: unknown },
): Promise<void> {
  await prisma.agentRun.update({
    where: { id: runId },
    data: {
      status: extra.status,
      outcome: result.outcome,
      errorKind: result.error?.kind ?? null,
      servedModel: result.servedModels.at(-1) ?? null,
      fallbackUsed: result.fallbackUsed,
      steps: result.steps,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadInputTokens,
      cacheWriteTokens: result.usage.cacheCreationInputTokens,
      durationMs: result.durationMs,
      trace: result.trace as unknown as Prisma.InputJsonValue,
      ...(extra.summary !== undefined ? { summary: extra.summary as Prisma.InputJsonValue } : {}),
      ...(extra.guardrail !== undefined ? { guardrail: extra.guardrail as Prisma.InputJsonValue } : {}),
      finishedAt: new Date(),
    },
  });
}

/** Mark a run FAILED after an exception in post-processing, then let the caller rethrow. */
export async function failAgentRun(runId: string): Promise<void> {
  await prisma.agentRun
    .update({
      where: { id: runId },
      data: { status: "FAILED", outcome: "HARNESS_ERROR", errorKind: "harness", finishedAt: new Date() },
    })
    .catch(() => undefined);
}
