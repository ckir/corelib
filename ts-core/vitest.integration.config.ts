import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const root = resolve(__dirname, "..");

export default defineConfig({
	resolve: {
		alias: {
			"@ckir/corelib": resolve(root, "ts-core/src/index.ts"),
			"@itest": resolve(root, "tests/integration"),
		},
	},
	test: {
		environment: "node",
		include: ["tests/integration/**/*.integration.test.ts"],
		setupFiles: [resolve(root, "tests/integration/_harness/setup.ts")],
		hookTimeout: 20000,
		testTimeout: 20000,
	},
});
