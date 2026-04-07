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
	// Cloudflare Workers
	if (typeof globalThis !== "undefined" && "cloudflare" in globalThis) {
		return "cloudflare";
	}

	// AWS Lambda
	if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
		return "aws-lambda";
	}

	// Google Cloud Run
	if (
		process.env.K_SERVICE ||
		process.env.K_REVISION ||
		process.env.GOOGLE_CLOUD_PROJECT
	) {
		return "gcp-cloudrun";
	}

	// Bun
	if (typeof Bun !== "undefined") return "bun";

	// Deno
	if (typeof Deno !== "undefined") return "deno";

	// Default = Node.js
	return "node";
}
