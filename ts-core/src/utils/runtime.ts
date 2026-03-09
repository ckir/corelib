// =============================================
// FILE: ts-core/src/utils/runtime.ts
// PURPOSE: Central runtime detector
// NEW: Respects RUNTIME= from .env (for Developers Cockpit)
// NEW FIXES (2026-03-05):
//   • Replaced (globalThis as any) with typeof checks for known globals (Bun, Deno)
//   • Added declarations for EdgeRuntime and __CFW__ to avoid any
// =============================================
export type Runtime =
	| "bun"
	| "node"
	| "deno"
	| "edge-cloudflare"
	| "edge-vercel"
	| "lambda"
	| "unknown";

declare var EdgeRuntime: unknown | undefined;
declare var __CFW__: unknown | undefined;

export function detectRuntime(): Runtime {
	// Developers Cockpit: honour RUNTIME=windows/bun/etc from root .env
	if (typeof process !== "undefined" && process.env?.RUNTIME) {
		const r = process.env.RUNTIME.toLowerCase().trim();
		if (["bun", "node", "deno"].includes(r)) return r as Runtime;
	}

	if (typeof Bun !== "undefined") return "bun";
	if (typeof Deno !== "undefined") return "deno";
	if (typeof EdgeRuntime !== "undefined" || typeof __CFW__ !== "undefined")
		return "edge-cloudflare";
	if (process.env.AWS_LAMBDA_FUNCTION_NAME) return "lambda";
	return "node";
}
