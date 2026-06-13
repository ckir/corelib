import { configDefaults, defineConfig } from "vitest/config";
export default defineConfig({
	test: {
		environment: "node",
		// Keep the integration tier out of the unit run (it has its own *.integration.config.ts
		// with the @itest/@ckir aliases + MSW setup). Without this, `test:run` sweeps them and fails.
		exclude: [...configDefaults.exclude, "**/tests/integration/**"],
	},
});
