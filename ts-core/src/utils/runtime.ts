// =============================================
// FILE: ts-core/src/utils/runtime.ts
// PURPOSE: Central runtime detector
// NEW: Respects RUNTIME= from .env (for Developers Cockpit)
// NEW FIXES (2026-03-05):
//   • Replaced (globalThis as any) with typeof checks for known globals (Bun, Deno)
//   • Added declarations for EdgeRuntime and __CFW__ to avoid any
// =============================================
export type Runtime =
	| "node"
	| "bun"
	| "deno"
	| "cloudflare" // Cloudflare Workers
	| "aws-lambda" // AWS Lambda
	| "gcp-cloudrun"; // Google Cloud Run

export function detectRuntime(): Runtime {
	// 0. Manual override via environment variable
	if (typeof process !== "undefined" && process.env && process.env.RUNTIME) {
		const envRuntime = process.env.RUNTIME.toLowerCase();
		if (
			[
				"node",
				"bun",
				"deno",
				"cloudflare",
				"aws-lambda",
				"gcp-cloudrun",
			].includes(envRuntime)
		) {
			return envRuntime as Runtime;
		}
	}

	// 1. Cloudflare Workers (High priority)
	// Check for globalThis.cloudflare (Workerd), __CFW__, caches, or known environment signals
	if (
		(typeof globalThis !== "undefined" &&
			("cloudflare" in globalThis ||
				"caches" in globalThis ||
				"WebSocketPair" in globalThis ||
				"__CFW__" in globalThis)) ||
		(typeof process !== "undefined" &&
			process.env &&
			process.env.PLATFORM === "cloudflare")
	) {
		return "cloudflare";
	}

	// 2. AWS Lambda
	if (
		typeof process !== "undefined" &&
		process.env &&
		process.env.AWS_LAMBDA_FUNCTION_NAME
	) {
		return "aws-lambda";
	}

	// 3. Google Cloud Run
	if (
		typeof process !== "undefined" &&
		process.env &&
		(process.env.K_SERVICE ||
			process.env.K_REVISION ||
			process.env.GOOGLE_CLOUD_PROJECT)
	) {
		return "gcp-cloudrun";
	}

	// Bun
	if (typeof Bun !== "undefined") return "bun";

	// Deno (Strict check to avoid polyfill false positives)
	if (
		typeof Deno !== "undefined" &&
		(Deno as any).version &&
		(Deno as any).version.deno
	) {
		return "deno";
	}

	// Default = Node.js
	return "node";
}
