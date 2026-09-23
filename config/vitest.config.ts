import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: resolve(import.meta.dirname, ".."),
  test: {
    include: ["tests/**/*.test.{ts,mjs}"],
    globalSetup: ["config/vitestTmp.ts"],
    maxWorkers: process.env.CI ? 2 : undefined,
    testTimeout: process.env.CI ? 15_000 : 5_000,
  },
});
