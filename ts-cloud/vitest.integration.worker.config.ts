// NOTE: @cloudflare/vitest-pool-workers@0.16.13 (vitest 4 era) dropped the
// "./config" entrypoint and `defineWorkersConfig`. The correct API is
// `cloudflareTest` (Vite plugin) from the package root, combined with
// `defineConfig` from vitest/config. The v3 → v4 codemod bundled at
// ./node_modules/@cloudflare/vitest-pool-workers/dist/codemods/vitest-v3-to-v4.mjs
// documents this migration.
import { createRequire } from "node:module";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);

export default defineConfig({
	plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.toml" } })],
	// tough-cookie (via @ckirg/corelib-markets → yahoo-finance2) uses tldts, whose
	// ES6 bundle has a relative import `./src/suffix-trie` that miniflare's CJS-shim
	// cannot resolve (extensionless, not in workerd module registry). Alias tldts to
	// its self-contained CJS bundle to bypass the problematic ESM relative import.
	resolve: {
		alias: {
			tldts: require.resolve("tldts/dist/cjs/index.js"),
		},
	},
	test: {
		include: ["tests/integration/**/*.worker.integration.test.ts"],
	},
});
