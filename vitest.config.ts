import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "server-only": path.join(root, "tests/shims/server-only.ts"),
    },
  },
  esbuild: {
    jsx: "automatic",
  },
  test: {
    environment: "node",
    env: {
      // Tests drive the risk queue explicitly instead of in the background after responses.
      NIGHTINGALE_RISK_AUTORUN: "off",
      // Integration tests authenticate handler calls with x-user-id; never enabled in production.
      NIGHTINGALE_ALLOW_HEADER_AUTH: "true",
    },
    include: ["tests/**/*.test.ts"],
    // SQLite cannot safely share one file across parallel test files (Windows locks).
    fileParallelism: false,
    maxWorkers: 1,
    environmentMatchGlobs: [["tests/test_ui_refresh.test.ts", "jsdom"]],
  },
});
