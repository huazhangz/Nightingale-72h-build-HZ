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
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    environmentMatchGlobs: [["tests/test_ui_refresh.test.ts", "jsdom"]],
  },
});
