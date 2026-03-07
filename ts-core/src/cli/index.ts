// =============================================
// FILE: ts-core/src/cli/index.ts
// PURPOSE: Dynamic runtime loader for Developers Cockpit
// FIXED: Manual .env parsing (no dotenv message) + early load so RUNTIME=bun works
//        Wrapped in async IIFE (tsx compatibility)
//        All unrelated features fully maintained
// NEW FIXES (2026-03-05):
//   • Removed explicit 'any' type for impl to let TS infer
// NEW ADDITIONS (2026-03-05):
//   • Added multi-runtime 'isMain' guard to prevent Cockpit from running on module import
//     (e.g., when importing '@ckir/corelib' in user code like test-logger.ts)
//     - For Node/Bun: process.argv[1] === __filename
//     - For Deno: Deno.mainModule === import.meta.url
//     - Prevents unwanted side-effects; Cockpit now only runs when file is executed directly (e.g., tsx src/cli/index.ts)
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

// Multi-runtime check: Is this module the entry point (main script)?
let isMain = false;
if (typeof Deno !== "undefined") {
	isMain = Deno.mainModule === import.meta.url;
} else if (typeof Bun !== "undefined") {
	isMain = Bun.main === import.meta.path;
} else {
	// Node
	const { fileURLToPath } = await import("node:url");
	const __filename = fileURLToPath(import.meta.url);
	isMain = process.argv[1] === __filename;
}

if (isMain) {
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
}
