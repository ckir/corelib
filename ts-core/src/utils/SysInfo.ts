// =============================================
// FILE: ts-core/src/utils/SysInfo.ts
// PURPOSE: Custom zero-dependency telemetry provider
// - Fully synchronous (async removed as requested)
// - Modernized ESM (createRequire) for Node/Bun
// - Auto-redacts secret env keys
// - Refreshed on EVERY log call when telemetry=on
// - Works on Node, Bun, Deno, and fallback
// =============================================

import { createRequire } from "node:module";
import { detectRuntime } from "./runtime";

// CJS require returns an untyped module — any on the return is intentional
type RequireFn = (id: string) => any;
let _require: RequireFn | undefined;
const getRequire = () => {
	if (!_require) {
		const runtime = detectRuntime();

		// 1. Try createRequire from node:module (Standard ESM way)
		if (typeof import.meta !== "undefined" && import.meta.url) {
			try {
				_require = createRequire(import.meta.url);
			} catch (_e) {
				// Ignore and try fallback
			}
		}

		// 2. Fallback to global require (CommonJS or some Deno modes)
		if (!_require && typeof (globalThis as any).require === "function") {
			_require = (globalThis as any).require;
		}

		// 3. Fallback to a throwing function if nothing worked
		if (!_require) {
			_require = (path: string) => {
				throw new Error(
					`require("${path}") is not available in this runtime (${runtime}).`,
				);
			};
		}
	}
	return _require;
};

/**
 * Redacts sensitive environment variables to prevent accidental leakage in logs.
 *
 * @param {Record<string, string | undefined>} env - The environment variables to redact.
 * @returns {Record<string, string>} A new object with sensitive values replaced by "[REDACTED]".
 */
function redactEnv(
	env: Record<string, string | undefined>,
): Record<string, string> {
	const redacted: Record<string, string> = {};
	const secretKeywords = [
		"KEY",
		"SECRET",
		"PASSWORD",
		"TOKEN",
		"AUTH",
		"CREDENTIAL",
		"APIKEY",
		"PRIVATE",
		"CERT",
		"KEYSTORE",
	];
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue;
		const upperKey = key.toUpperCase();
		const isSecret = secretKeywords.some((k) => upperKey.includes(k));
		redacted[key] = isSecret ? "[REDACTED]" : value;
	}
	return redacted;
}

/**
 * Collects system information in Node-like environments (Node.js, Bun).
 *
 * @param {"node" | "bun"} runtime - The current runtime.
 * @returns {object} System information object.
 */
function fromNodeLike(runtime: "node" | "bun") {
	const os = getRequire()("node:os");

	const mem: ReturnType<typeof process.memoryUsage> | Record<string, never> =
		typeof process.memoryUsage === "function" ? process.memoryUsage() : {};

	return {
		/** Current runtime name. */
		runtime,
		/** Operating system platform. */
		os: process.platform,
		/** System architecture. */
		arch: process.arch,
		/** Process ID. */
		pid: process.pid,
		/** Parent process ID. */
		ppid: process.ppid ?? null,
		/** Current working directory. */
		cwd: process.cwd(),
		/** Process uptime in seconds. */
		uptime: process.uptime(),
		/** Operating system version/release. */
		osVersion: os.release?.() ?? null,
		/** System load averages for 1, 5, and 15 minutes. */
		loadAvg: os.loadavg?.() ?? [0, 0, 0],
		/** Memory usage statistics. */
		memory: {
			/** Resident Set Size. */
			rss: mem.rss ?? null,
			/** Total heap size. */
			heapTotal: mem.heapTotal ?? null,
			/** Used heap size. */
			heapUsed: mem.heapUsed ?? null,
			/** Memory used by C++ objects bound to JavaScript objects. */
			external: mem.external ?? null,
		},
		/** Redacted environment variables. */
		env: redactEnv({ ...process.env }),
	};
}

/**
 * Collects system information in Deno.
 * @returns {object} System information object.
 */
function fromDeno() {
	const DenoAny = typeof Deno !== "undefined" ? (Deno as any) : null;
	const mem =
		DenoAny && typeof DenoAny.systemMemoryInfo === "function"
			? DenoAny.systemMemoryInfo()
			: {};

	return {
		runtime: "deno",
		os: DenoAny?.build?.os ?? "unknown",
		arch: DenoAny?.build?.arch ?? "unknown",
		pid: DenoAny?.pid ?? null,
		ppid: DenoAny?.ppid ?? null,
		cwd: DenoAny?.cwd?.() ?? "",
		uptime: typeof performance !== "undefined" ? performance.now() / 1000 : 0,
		osVersion: DenoAny?.osRelease?.() ?? null,
		loadAvg: DenoAny?.loadavg?.() ?? [0, 0, 0],
		memory: {
			rss: mem.total ?? null,
			heapTotal: null,
			heapUsed: null,
			external: null,
		},
		env: redactEnv(DenoAny?.env?.toObject() ?? {}),
	};
}

/**
 * Provides a fallback system information object for unsupported runtimes.
 * @returns {object} Generic system information object.
 */
function fallback() {
	return {
		runtime: "unknown",
		os: "unknown",
		arch: "unknown",
		pid: null,
		ppid: null,
		cwd: "",
		uptime: 0,
		osVersion: null,
		loadAvg: [0, 0, 0],
		memory: {
			rss: null,
			heapTotal: null,
			heapUsed: null,
			external: null,
		},
		env: {} as Record<string, string>,
	};
}

/**
 * Main entry point for collecting system telemetry.
 * Automatically detects the runtime and gathers relevant system, process, and environment information.
 *
 * @returns {object} Comprehensive system information.
 */
export function getSysInfo() {
	const runtime = detectRuntime();

	switch (runtime) {
		case "node":
		case "bun":
			return fromNodeLike(runtime);
		case "deno":
			return fromDeno();
		default:
			return fallback();
	}
}

/**
 * @deprecated Use getSysInfo or detectRuntime instead.
 */
export const SysInfo = {
	/**
	 * Gets system information.
	 */
	get: getSysInfo,
};
