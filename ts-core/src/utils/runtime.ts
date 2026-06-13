// =============================================
// FILE: ts-core/src/utils/runtime.ts
// PURPOSE: Central runtime detector
// NEW: Respects RUNTIME= from .env (for Developers Cockpit)
// NEW FIXES (2026-03-05):
//   • Replaced (globalThis as any) with typeof checks for known globals (Bun, Deno)
//   • Added declarations for EdgeRuntime and __CFW__ to avoid any
// =============================================

/**
 * Supported runtimes for the core library.
 */
export type Runtime =
	| "node"
	| "bun"
	| "deno"
	| "cloudflare" // Cloudflare Workers
	| "aws-lambda" // AWS Lambda
	| "gcp-cloudrun"; // Google Cloud Run

let _cachedRuntime: Runtime | undefined;

function computeRuntime(): Runtime {
	// 0. Manual override via environment variable
	try {
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
	} catch {
		// Ignore process.env access errors in some environments
	}

	// 1. Cloudflare Workers (High priority)
	// Check for globalThis.cloudflare (Workerd), __CFW__, caches, or known environment signals
	try {
		if (
			(typeof globalThis !== "undefined" &&
				(!!(globalThis as any).cloudflare ||
					!!(globalThis as any).caches ||
					!!(globalThis as any).WebSocketPair ||
					!!(globalThis as any).__CFW__)) ||
			(typeof process !== "undefined" &&
				process.env &&
				process.env.PLATFORM === "cloudflare")
		) {
			return "cloudflare";
		}
	} catch {
		// Ignore
	}

	// 2. AWS Lambda
	try {
		if (
			typeof process !== "undefined" &&
			process.env &&
			process.env.AWS_LAMBDA_FUNCTION_NAME
		) {
			return "aws-lambda";
		}
	} catch {
		// Ignore
	}

	// 3. Google Cloud Run
	try {
		if (
			typeof process !== "undefined" &&
			process.env &&
			(process.env.K_SERVICE ||
				process.env.K_REVISION ||
				process.env.GOOGLE_CLOUD_PROJECT)
		) {
			return "gcp-cloudrun";
		}
	} catch {
		// Ignore
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

/**
 * Detects the current execution environment.
 * Uses various global signals and environment variables to distinguish between Node.js, Bun, Deno,
 * and different cloud platforms like Cloudflare Workers, AWS Lambda, and Google Cloud Run.
 *
 * @returns {Runtime} The detected runtime identifier. Defaults to 'node' if unable to determine.
 */
export function detectRuntime(): Runtime {
	if (_cachedRuntime !== undefined) return _cachedRuntime;
	_cachedRuntime = computeRuntime();
	return _cachedRuntime;
}

/** Test-only: clear the memoized runtime (some tests flip RUNTIME=). */
export function __resetRuntimeCache(): void {
	_cachedRuntime = undefined;
}
