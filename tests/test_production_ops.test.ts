import { describe, expect, it } from "vitest";
import { handleHealth } from "../src/lib/api/health";
import { checkStartupConfig } from "../src/lib/config/startup";

const env = (values: Record<string, string>) => values as unknown as NodeJS.ProcessEnv;
const SECRET = "x".repeat(64);

describe("startup configuration check", () => {
  it("refuses an unsafe production configuration", () => {
    const report = checkStartupConfig(env({ NODE_ENV: "production", NIGHTINGALE_DEMO_MODE: "true" }));
    expect(report.errors.join(" ")).toContain("NIGHTINGALE_SESSION_SECRET");
    expect(report.errors.join(" ")).toContain("NIGHTINGALE_DEMO_MODE");
  });

  it("accepts a sound production configuration and only warns about soft issues", () => {
    const report = checkStartupConfig(env({ NODE_ENV: "production", NIGHTINGALE_SESSION_SECRET: SECRET, NIGHTINGALE_CRON_SECRET: "short" }));
    expect(report.errors).toEqual([]);
    expect(report.warnings.join(" ")).toContain("NIGHTINGALE_PUBLIC_URL");
    expect(report.warnings.join(" ")).toContain("NIGHTINGALE_CRON_SECRET");
    expect(report.warnings.join(" ")).toContain("No credentials");
    expect(report.summary.join(" ")).toContain("agents: anthropic (not configured)");
    // Secret values are never printed.
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it("only warns in development", () => {
    const report = checkStartupConfig(env({ NODE_ENV: "development", NIGHTINGALE_AGENT_CLIENT: "simulated" }));
    expect(report.errors).toEqual([]);
    expect(report.warnings.join(" ")).toContain("NIGHTINGALE_SESSION_SECRET");
    expect(report.summary.join(" ")).toContain("agents: simulated");
  });
});

describe("health endpoint", () => {
  it("reports database and queue status without any record content", async () => {
    const response = await handleHealth();
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "ok", database: "ok", riskQueue: { queued: expect.any(Number), failedLastDay: expect.any(Number) } });
    expect(Object.keys(body).sort()).toEqual(["database", "riskQueue", "status", "uptimeSeconds"]);
  });
});
