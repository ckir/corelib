import { configDefaults, defineConfig } from "vitest/config";
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
				statements: 78,
				branches: 68,
				functions: 78,
				lines: 78,
			},
		},
		environment: "node",
		// Keep the integration tier out of the unit run (it has its own *.integration.config.ts
		// with the @itest/@ckir aliases + MSW setup). Without this, `test:run` sweeps them and fails.
		exclude: [...configDefaults.exclude, "**/tests/integration/**"],
	},
});
