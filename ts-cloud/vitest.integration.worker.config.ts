import { resolve } from "node:path";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

const root = resolve(__dirname, "..");

export default defineWorkersConfig({
	resolve: {
		alias: {
			"@ckir/corelib": resolve(root, "ts-core/src/index.ts"),
			"@ckir/corelib-markets": resolve(root, "ts-markets/src/index.ts"),
			"@ckir/corelib-cloud": resolve(root, "ts-cloud/src/index.ts"),
		},
	},
	test: {
		include: ["tests/integration/**/*.worker.integration.test.ts"],
		poolOptions: {
			workers: { wrangler: { configPath: "./wrangler.toml" } },
		},
	},
});
