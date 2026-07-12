import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    hookTimeout: 120_000,
    include: ["src/**/*.stress.test.ts"],
    maxWorkers: 1,
    passWithNoTests: true,
    testTimeout: 120_000,
  },
});
