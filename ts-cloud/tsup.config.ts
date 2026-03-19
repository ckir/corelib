import { defineConfig } from "tsup";

export default defineConfig([
	{
		entry: { worker: "src/platform/cloudflare/worker.ts" },
		format: ["esm"],
		target: "es2022",
		noExternal: [/.*/],
		shims: true,
		minify: true,
		clean: true,
		outDir: "dist/cloudflare",
		platform: "node",
	},
	{
		entry: { handler: "src/platform/aws/handler.ts" },
		format: ["esm"], // Changed from cjs to esm
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
		target: "node24",
		noExternal: [/.*/],
		minify: true,
		clean: true,
		outDir: "dist/cloudrun",
		platform: "node",
	},
]);
