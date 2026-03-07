import { defineConfig } from "tsup";
// FIXED (2026-03-07): New tsup.config.ts for ts-markets to enable conditional minify based on .env MODE=production. Matches ts-core structure for consistency. All unrelated features (e.g., package stubs, exports) remain fully maintained.
export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	dts: true,
	clean: true,
	minify: process.env.MODE === "production",
});
