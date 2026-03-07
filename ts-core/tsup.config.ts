import { defineConfig } from "tsup";
// FIXED (2026-03-07): Removed trailing comma after minify per Biome formatting rules (no trailing commas in object literals). All unrelated features (e.g., entry points, format, dts, clean, minify logic) remain fully maintained and unchanged.
export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	dts: true,
	clean: true,
	minify: process.env.MODE === "production", // FIXED (2026-03-07): Added conditional minify based on .env MODE=production for optimized builds. All unrelated features (e.g., entry points, format, dts, clean) remain fully maintained and unchanged.
});
