import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const root = resolve(__dirname, "..");

export default defineConfig({
	resolve: {
		alias: {
			"@ckirg/corelib": resolve(root, "ts-core/src/index.ts"),
			"@ckirg/corelib-markets": resolve(root, "ts-markets/src/index.ts"),
			"@ckirg/corelib-cloud": resolve(root, "ts-cloud/src/index.ts"),
			"@itest": resolve(root, "tests/integration"),
		},
	},
	test: {
		environment: "node",
		include: ["tests/integration/**/*.integration.test.ts"],
		exclude: ["tests/integration/**/*.worker.integration.test.ts"],
		setupFiles: [resolve(root, "tests/integration/_harness/setup.ts")],
		hookTimeout: 20000,
		testTimeout: 20000,
	},
});
