// =============================================
// FILE: ts-core/src/cli/index.ts
// PURPOSE: Dynamic runtime loader for Developers Cockpit
// FIXED: Manual .env parsing (no dotenv message) + early load so RUNTIME=bun works
//        Wrapped in async IIFE (tsx compatibility)
//        All unrelated features fully maintained
// NEW FIXES (2026-03-05):
//   • Removed explicit 'any' type for impl to let TS infer
// =============================================

import { detectRuntime } from "../common/runtime";

async function earlyLoadEnvForNode() {
	const auto = detectRuntime();
	if (auto !== "node") return;

	const pathMod = await import("node:path");
	const fsMod = await import("node:fs/promises");
	const envPath = pathMod.default.join(process.cwd(), "../.env");

	try {
		const content = await fsMod.readFile(envPath, "utf8");
		content.split("\n").forEach((line) => {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) return;
			const [key, ...rest] = trimmed.split("=");
			if (key) {
				const value = rest
					.join("=")
					.trim()
					.replace(/^["']|["']$/g, "");
				process.env[key.trim()] = value;
			}
		});
	} catch {}
}

(async () => {
	await earlyLoadEnvForNode();

	const runtime = detectRuntime();

	let impl: { default: () => Promise<void> };
	switch (runtime) {
		case "bun":
			impl = await import("./impementations/bun.js");
			break;
		case "deno":
			impl = await import("./impementations/deno.js");
			break;
		default:
			impl = await import("./impementations/node.js");
	}
	await impl.default();
})().catch(console.error);
