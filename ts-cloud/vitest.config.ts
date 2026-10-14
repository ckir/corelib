import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Floors sit ~2 points under the coverage measured when this was added, so a real regression
		// fails CI but a small refactor does not. Raise them as coverage improves.
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["**/*.test.ts", "**/test-utils/**", "**/*.d.ts"],
			reporter: ["text-summary", "json-summary"],
			thresholds: {
				statements: 83,
				branches: 84,
				functions: 88,
				lines: 83,
			},
		},
		workers: {
			wrangler: { configPath: "./wrangler.toml" },
		},
		include: ["src/**/*.{test,spec}.ts"],
	},
});
