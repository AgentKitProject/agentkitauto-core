import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Contract tests that require DYNAMODB_ENDPOINT are gated in each file;
    // pg-mem tests run unconditionally and need no external services.
    passWithNoTests: true,
  },
});
