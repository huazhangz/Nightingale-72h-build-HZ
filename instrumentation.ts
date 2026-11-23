/**
 * Runs once when the Next.js server starts. Checks configuration before the first request: in
 * production, unsafe settings stop the process with a clear message instead of failing later.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }
  const { checkStartupConfig } = await import("./src/lib/config/startup");
  const report = checkStartupConfig();
  console.log(`[nightingale] ${report.summary.join(" · ")}`);
  for (const warning of report.warnings) {
    console.warn(`[nightingale] warning: ${warning}`);
  }
  if (report.errors.length > 0) {
    for (const error of report.errors) {
      console.error(`[nightingale] configuration error: ${error}`);
    }
    console.error("[nightingale] refusing to start with an unsafe production configuration.");
    // Exit rather than throw: Next.js logs a failed instrumentation hook but keeps the process
    // alive, which would leave a container "running" that can never serve a request.
    process.exit(1);
  }
}
