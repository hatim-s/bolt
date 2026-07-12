import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    exclude: [
      "**/*.stress.test.ts",
      "artifacts/**",
      "dist/**",
      "dist-playground/**",
      "node_modules/**",
    ],
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
    coverage: {
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.stress.test.ts",
        "src/**/*.typecheck.ts",
        "src/bolt/index.ts",
      ],
      include: ["src/bolt/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "artifacts/coverage",
      thresholds: {
        branches: 70,
        functions: 70,
        lines: 70,
        statements: 70,
      },
    },
  },
});
