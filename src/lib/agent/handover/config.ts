import { createAnthropicClient, type ClientFactory } from "../core/client";
import { DEFAULT_GEMINI_MODEL, geminiFetch } from "../core/gemini";
import { DEFAULT_RUN_CONFIG } from "../core/run-agent";
import { scriptedFetch, type Responder } from "../core/testing";
import type { Effort } from "../core/types";
import { DEFAULT_PROMPT_VERSION, isPromptVersion, type PromptVersion } from "./prompts";
import { CLEAN_PROFILE, simulatedResponder } from "./simulated-client";

/** Runtime settings for the handover agent, read from the environment and validated. */
export type HandoverAgentSettings = {
  model: string;
  effort: Effort;
  maxIterations: number;
  maxTokens: number;
  tokenBudget: number;
  deadlineMs: number;
  promptVersion: PromptVersion;
  fallbacks: "default" | null;
  /**
   * "anthropic" needs ANTHROPIC_API_KEY; "gemini" runs the same agents on Google Gemini through a
   * transport adapter and needs GEMINI_API_KEY; "simulated" is the offline rule policy for demos.
   */
  client: "anthropic" | "gemini" | "simulated";
};

export const DEFAULT_MODEL = "claude-opus-5-5";
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export class AgentNotConfiguredError extends Error {
  readonly code = "AGENT_NOT_CONFIGURED" as const;
  constructor() {
    super(
      "The AI agents need ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN), or NIGHTINGALE_AGENT_CLIENT=gemini with " +
        "GEMINI_API_KEY, and NIGHTINGALE_AGENTS_ENABLED not set to false. Set NIGHTINGALE_AGENT_CLIENT=simulated " +
        "for the offline demo policy.",
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
  const client: HandoverAgentSettings["client"] =
    env.NIGHTINGALE_AGENT_CLIENT === "simulated" ? "simulated" : env.NIGHTINGALE_AGENT_CLIENT === "gemini" ? "gemini" : "anthropic";
  const configuredModel = env.NIGHTINGALE_AGENT_MODEL?.trim();
  return {
    // Record what actually answers: a simulated run must never be logged as a Claude model.
    model: client === "simulated" ? SIMULATED_MODEL : configuredModel || (client === "gemini" ? DEFAULT_GEMINI_MODEL : DEFAULT_MODEL),
    effort: effort && EFFORTS.includes(effort) ? effort : "medium",
    maxIterations: intFrom(env.NIGHTINGALE_AGENT_MAX_STEPS, DEFAULT_RUN_CONFIG.maxIterations, 2, 30),
    maxTokens: intFrom(env.NIGHTINGALE_AGENT_MAX_TOKENS, DEFAULT_RUN_CONFIG.maxTokens, 1_024, 64_000),
    tokenBudget: intFrom(env.NIGHTINGALE_AGENT_TOKEN_BUDGET, DEFAULT_RUN_CONFIG.tokenBudget, 10_000, 2_000_000),
    deadlineMs: intFrom(env.NIGHTINGALE_AGENT_DEADLINE_MS, DEFAULT_RUN_CONFIG.deadlineMs, 5_000, 900_000),
    promptVersion: isPromptVersion(prompt) ? prompt : DEFAULT_PROMPT_VERSION,
    // Server-side refusal fallback is an Anthropic feature.
    fallbacks: client !== "anthropic" || env.NIGHTINGALE_AGENT_FALLBACKS === "off" ? null : "default",
    client,
  };
}

export function hasAnthropicCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim());
}

export function geminiApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim() || null;
}

/** Client factory for the Gemini transport (also used by the evaluation runners). */
export function geminiClientFactory(options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): ClientFactory {
  const env = options.env ?? process.env;
  const apiKey = geminiApiKey(env);
  if (!apiKey) {
    throw new AgentNotConfiguredError();
  }
  const minIntervalMs = intFrom(env.NIGHTINGALE_GEMINI_MIN_INTERVAL_MS, 0, 0, 120_000);
  return ({ onResponseStatus }) =>
    createAnthropicClient({
      apiKey: "gemini-transport",
      timeoutMs: options.timeoutMs ?? 120_000,
      fetch: geminiFetch({ apiKey, minIntervalMs }),
      onResponseStatus,
    });
}

/** Global kill switch for every model call (rule-based features keep working). */
export function agentsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NIGHTINGALE_AGENTS_ENABLED !== "false";
}

export function isAgentAvailable(settings: HandoverAgentSettings, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!agentsEnabled(env)) {
    return false;
  }
  if (settings.client === "simulated") {
    return true;
  }
  return settings.client === "gemini" ? geminiApiKey(env) !== null : hasAnthropicCredentials(env);
}

/**
 * Client factory for one run. "simulated" routes the real SDK Tool Runner through a scripted fetch
 * that answers with the offline rule policy; "anthropic" uses the real API with SDK-managed retries.
 */
export function createClientFactory(
  settings: HandoverAgentSettings,
  offline: () => Responder = () => simulatedResponder(CLEAN_PROFILE, SIMULATED_MODEL),
  env: NodeJS.ProcessEnv = process.env,
): ClientFactory {
  if (!agentsEnabled(env)) {
    throw new AgentNotConfiguredError();
  }
  if (settings.client === "simulated") {
    return ({ onResponseStatus }) =>
      createAnthropicClient({
        apiKey: "offline-simulated",
        maxRetries: 0,
        fetch: scriptedFetch(offline()).fetch,
        onResponseStatus,
      });
  }
  if (settings.client === "gemini") {
    return geminiClientFactory({ timeoutMs: Math.min(settings.deadlineMs, 120_000), env });
  }
  if (!hasAnthropicCredentials(env)) {
    throw new AgentNotConfiguredError();
  }
  return ({ onResponseStatus }) =>
    createAnthropicClient({ timeoutMs: Math.min(settings.deadlineMs, 120_000), onResponseStatus });
}
