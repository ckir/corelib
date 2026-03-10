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

function fromNodeLike(runtime: "node" | "bun") {
	const require = createRequire(import.meta.url);
	const os = require("node:os");

	const mem: any =
		typeof process.memoryUsage === "function" ? process.memoryUsage() : {};

	return {
		runtime,
		os: process.platform,
		arch: process.arch,
		pid: process.pid,
		ppid: process.ppid ?? null,
		cwd: process.cwd(),
		uptime: process.uptime(),
		osVersion: os.release?.() ?? null,
		loadAvg: os.loadavg?.() ?? [0, 0, 0],
		memory: {
			rss: mem.rss ?? null,
			heapTotal: mem.heapTotal ?? null,
			heapUsed: mem.heapUsed ?? null,
			external: mem.external ?? null,
		},
		env: redactEnv({ ...process.env }),
	};
}

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
		env: {},
	};
}

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
	get: getSysInfo,
};
