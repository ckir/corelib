import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		workers: {
			wrangler: { configPath: "./wrangler.toml" },
		},
		include: ["src/**/*.{test,spec}.ts"],
	},
});
