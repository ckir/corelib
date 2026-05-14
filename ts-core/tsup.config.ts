import { defineConfig } from "tsup";
// FIXED (2026-03-07): Removed trailing comma after minify per Biome formatting rules (no trailing commas in object literals). All unrelated features (e.g., entry points, format, dts, clean, minify logic) remain fully maintained and unchanged.
export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	dts: true,
	clean: true,
	minify: process.env.MODE === "production",
	external: [
		"pino",
		"pino-pretty",
		"serialize-error",
		"luxon",
		"deepmerge-ts",
		"confbox",
		"commander",
		"croner",
		"ky",
		"@libsql/client",
		"postgres",
		"@google-cloud/pino-logging-gcp-config",
		"pino-lambda",
		"pino-socket",
	],
});
