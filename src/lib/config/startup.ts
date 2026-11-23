/**
 * Startup configuration check, run once when the server starts (instrumentation.ts).
 *
 * Production refuses to start on settings that would make it unsafe (no session secret, demo mode)
 * and warns about settings that degrade it. Development only warns. Messages name the variable and
 * the fix; they never print secret values.
 */

export type StartupReport = { errors: string[]; warnings: string[]; summary: string[] };

export function checkStartupConfig(env: NodeJS.ProcessEnv = process.env): StartupReport {
  const production = env.NODE_ENV === "production";
  const errors: string[] = [];
  const warnings: string[] = [];
  const problem = (message: string) => (production ? errors : warnings).push(message);

  const secret = env.NIGHTINGALE_SESSION_SECRET ?? "";
  if (secret.length < 32) {
    problem("NIGHTINGALE_SESSION_SECRET must be set to at least 32 characters (e.g. `openssl rand -hex 32`).");
  }
  if (env.NIGHTINGALE_DEMO_MODE === "true") {
    problem("NIGHTINGALE_DEMO_MODE=true exposes demo sign-in shortcuts and must not be set in production.");
  }
  if (env.NIGHTINGALE_ALLOW_HEADER_AUTH === "true" && production) {
    warnings.push("NIGHTINGALE_ALLOW_HEADER_AUTH is ignored in production (header authentication is test-only).");
  }
  if (production && !env.NIGHTINGALE_PUBLIC_URL) {
    warnings.push("NIGHTINGALE_PUBLIC_URL is not set: activation and reset links will use the request's Host header.");
  }
  if (env.NIGHTINGALE_CRON_SECRET && env.NIGHTINGALE_CRON_SECRET.length < 16) {
    warnings.push("NIGHTINGALE_CRON_SECRET is shorter than 16 characters, so the risk-queue drain endpoint stays disabled.");
  }
  if (production && env.NIGHTINGALE_AGENT_CLIENT === "simulated") {
    warnings.push("NIGHTINGALE_AGENT_CLIENT=simulated: agents run the offline rule policy, not a language model.");
  }

  const client = env.NIGHTINGALE_AGENT_CLIENT ?? "anthropic";
  const agentsOff = env.NIGHTINGALE_AGENTS_ENABLED === "false";
  const keyPresent =
    client === "gemini" ? Boolean(env.GEMINI_API_KEY || env.GOOGLE_API_KEY) : client === "simulated" ? true : Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
  if (!agentsOff && !keyPresent) {
    warnings.push(
      `No credentials for the "${client}" agent client: risk levels fall back to the rule floor and the handover panel reports the agent as not configured.`,
    );
  }

  const summary = [
    `environment: ${production ? "production" : env.NODE_ENV ?? "development"}`,
    `agents: ${agentsOff ? "disabled" : `${client}${keyPresent ? "" : " (not configured)"}`}`,
    `risk queue: ${env.NIGHTINGALE_RISK_AUTORUN === "off" ? "cron only" : "after each request"}${env.NIGHTINGALE_CRON_SECRET && env.NIGHTINGALE_CRON_SECRET.length >= 16 ? " + cron endpoint" : ""}`,
    `demo mode: ${env.NIGHTINGALE_DEMO_MODE === "true" ? "ON" : "off"}`,
  ];
  return { errors, warnings, summary };
}
