import { AnthropicModelClient } from "../runtime/anthropic-client";
import { DEFAULT_LOOP_CONFIG } from "../runtime/loop";
import type { Effort, ModelClient } from "../runtime/types";
import { DEFAULT_PROMPT_VERSION, isPromptVersion, type PromptVersion } from "./prompts";
import { CLEAN_PROFILE, SimulatedHandoverClient } from "./simulated-client";

/** Runtime settings for the handover agent, read from the environment and validated. */
export type HandoverAgentSettings = {
  model: string;
  effort: Effort;
  maxSteps: number;
  maxTokens: number;
  tokenBudget: number;
  deadlineMs: number;
  promptVersion: PromptVersion;
  fallbacks: "default" | null;
  /** "anthropic" needs credentials; "simulated" is the offline rule policy for demos. */
  client: "anthropic" | "simulated";
};

export const DEFAULT_MODEL = "claude-opus-5-5";
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export class AgentNotConfiguredError extends Error {
  readonly code = "AGENT_NOT_CONFIGURED" as const;
  constructor() {
    super(
      "The handover agent needs ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN). " +
        "Set NIGHTINGALE_AGENT_CLIENT=simulated for the offline demo policy.",
    );
    this.name = "AgentNotConfiguredError";
  }
}

function intFrom(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export const SIMULATED_MODEL = "simulated-rule-policy";

export function agentSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): HandoverAgentSettings {
  const effort = env.NIGHTINGALE_AGENT_EFFORT as Effort | undefined;
  const prompt = env.NIGHTINGALE_AGENT_PROMPT;
  const simulated = env.NIGHTINGALE_AGENT_CLIENT === "simulated";
  return {
    // Record what actually answers: a simulated run must never be logged as a Claude model.
    model: simulated ? SIMULATED_MODEL : env.NIGHTINGALE_AGENT_MODEL?.trim() || DEFAULT_MODEL,
    effort: effort && EFFORTS.includes(effort) ? effort : "medium",
    maxSteps: intFrom(env.NIGHTINGALE_AGENT_MAX_STEPS, DEFAULT_LOOP_CONFIG.maxSteps, 2, 30),
    maxTokens: intFrom(env.NIGHTINGALE_AGENT_MAX_TOKENS, DEFAULT_LOOP_CONFIG.maxTokens, 1_024, 64_000),
    tokenBudget: intFrom(env.NIGHTINGALE_AGENT_TOKEN_BUDGET, DEFAULT_LOOP_CONFIG.tokenBudget, 10_000, 2_000_000),
    deadlineMs: intFrom(env.NIGHTINGALE_AGENT_DEADLINE_MS, DEFAULT_LOOP_CONFIG.deadlineMs, 5_000, 900_000),
    promptVersion: isPromptVersion(prompt) ? prompt : DEFAULT_PROMPT_VERSION,
    fallbacks: env.NIGHTINGALE_AGENT_FALLBACKS === "off" ? null : "default",
    client: simulated ? "simulated" : "anthropic",
  };
}

export function hasAnthropicCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim());
}

export function isAgentAvailable(settings: HandoverAgentSettings, env: NodeJS.ProcessEnv = process.env): boolean {
  return settings.client === "simulated" || hasAnthropicCredentials(env);
}

export function createModelClient(settings: HandoverAgentSettings, env: NodeJS.ProcessEnv = process.env): ModelClient {
  if (settings.client === "simulated") {
    return new SimulatedHandoverClient(CLEAN_PROFILE, SIMULATED_MODEL);
  }
  if (!hasAnthropicCredentials(env)) {
    throw new AgentNotConfiguredError();
  }
  return new AnthropicModelClient({ timeoutMs: Math.min(settings.deadlineMs, 120_000) });
}
