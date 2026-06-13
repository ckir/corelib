import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    root: __dirname,
    include: ["**/*.probe.test.ts", "_harness/**/*.test.ts"],
    environment: "node",
  },
});
