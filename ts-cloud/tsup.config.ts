import { defineConfig } from "tsup";

export default defineConfig([
	{
		entry: { worker: "src/platform/cloudflare/worker.ts" },
		format: ["esm"],
		target: "es2022",
		// Force-bundle ONLY the edge-safe app/workspace packages into worker.js —
		// workerd has no node_modules resolution, so these bare specifiers must be
		// inlined. A catch-all noExternal:[/.*/] would also pull in the Node-only
		// deps below (and override the RegExp externals), so we list explicitly.
		noExternal: ["@ckir/corelib", "@ckir/corelib-markets", "hono"],
		// Carve-outs. All of these are reachable ONLY behind runtime-gated dynamic
		// import()s in @ckir/corelib (logger picks ./implementations/cloudflare.js on
		// edge; DB drivers load via `await import(...)` only when a DB is created), so
		// they never execute during edge boot. Node builtins are supplied by
		// nodejs_compat at load time; platform:"neutral" can't resolve them at build.
		external: [
			// Node builtins in BOTH bare and `node:`-prefixed forms (+ subpaths).
			/^(node:)?(assert|async_hooks|buffer|child_process|cluster|console|constants|crypto|dgram|diagnostics_channel|dns|domain|events|fs|http|http2|https|inspector|module|net|os|path|perf_hooks|process|punycode|querystring|readline|repl|stream|string_decoder|sys|timers|tls|trace_events|tty|url|util|v8|vm|wasi|worker_threads|zlib)(\/.*)?$/,
			// pino logging stack (only loaded by node/gcp/lambda logger impls).
			"pino",
			"pino-pretty",
			"pino-lambda",
			"pino-socket",
			"@google-cloud/pino-logging-gcp-config",
			// DB drivers (loaded only when createDatabase() opens a connection).
			"@libsql/client",
			"postgres",
		],
		define: { __EDGE_RUNTIME__: "true" },
		shims: true,
		minify: true,
		clean: true,
		outDir: "dist/cloudflare",
		platform: "neutral",
	},
	{
		entry: { handler: "src/platform/aws/handler.ts" },
		format: ["esm"],
		shims: true,
		outExtension() {
			return { js: ".mjs" };
		},
		banner: {
			js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
		},
		target: "node24",
		noExternal: [/.*/],
		minify: true,
		clean: true,
		outDir: "dist/aws",
		platform: "node",
	},
	{
		entry: { server: "src/platform/cloudrun/server.ts" },
		format: ["esm"],
		shims: true,
		banner: {
			js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
		},
		target: "node24",
		noExternal: [/.*/],
		minify: true,
		clean: true,
		outDir: "dist/cloudrun",
		platform: "node",
	},
]);
