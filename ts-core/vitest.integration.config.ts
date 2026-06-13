import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const root = resolve(__dirname, "..");

export default defineConfig({
	root,
	resolve: {
		alias: {
			"@ckir/corelib": resolve(root, "ts-core/src/index.ts"),
			"@itest": resolve(root, "tests/integration"),
		},
	},
	test: {
		environment: "node",
		include: [
			"ts-core/tests/integration/**/*.integration.test.ts",
			"tests/integration/_harness/**/*.test.ts",
			"tests/integration/coverage-validator.test.ts",
		],
		setupFiles: [resolve(root, "tests/integration/_harness/setup.ts")],
		hookTimeout: 20000,
		testTimeout: 20000,
	},
});
