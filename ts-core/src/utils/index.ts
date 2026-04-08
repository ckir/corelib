// =============================================
// FILE: ts-core/src/utils/index.ts
// PURPOSE: Utils category – exported as named import
// Example: import { Utils, SysInfo } from '@ckir/corelib'
// NEW: Re-exports SysInfo for telemetry
// NEW: Multi-runtime abstractions for env, file, cwd, dirname
// NEW: Added getPlatform and getMode from ConfigUtils
// =============================================

import { createRequire } from "node:module";
import { detectRuntime } from "./runtime";

let _require: any;
export const getRequire = () => {
	if (!_require) {
		const runtime = detectRuntime();
		const isNodeLike = [
			"node",
			"bun",
			"aws-lambda",
			"gcp-cloudrun",
		].includes(runtime);

		if (
			isNodeLike &&
			typeof import.meta !== "undefined" &&
			import.meta.url
		) {
			_require = createRequire(import.meta.url);
		} else {
			_require = (path: string) => {
				throw new Error(
					`require("${path}") is not available in this runtime (${runtime}).`,
				);
			};
		}
	}
	return _require;
};

export { includeExcludeCron } from "./cron";
export { detectRuntime, type Runtime } from "./runtime";
export { getSysInfo, SysInfo } from "./SysInfo";

export const Utils = {
	run: () => console.log(`[UTILS] Running on ${detectRuntime()}`),
};

export const getEnv = (key: string): string | undefined => {
	if (detectRuntime() === "deno") {
		return Deno.env.get(key);
	} else {
		return process.env[key];
	}
};

export const getAllEnv = (): Record<string, string | undefined> => {
	if (detectRuntime() === "deno") {
		return Deno.env.toObject();
	} else {
		return { ...process.env };
	}
};

export const readTextFileSync = (file: string): string => {
	if (detectRuntime() === "deno") {
		return Deno.readTextFileSync(file);
	} else {
		const { readFileSync } = getRequire()("node:fs");
		return readFileSync(file, "utf8");
	}
};

export const existsSync = (file: string): boolean => {
	if (detectRuntime() === "deno") {
		try {
			Deno.statSync(file);
			return true;
		} catch {
			return false;
		}
	} else {
		const { existsSync } = getRequire()("node:fs");
		return existsSync(file);
	}
};

export const getCwd = (): string => {
	if (detectRuntime() === "deno") {
		return Deno.cwd();
	} else {
		return process.cwd();
	}
};

export const getDirname = () => {
	const runtime = detectRuntime();
	if (runtime === "deno") {
		return new URL(".", import.meta.url).pathname;
	}

	// Edge-safe getDirname for Node, Bun, Cloudflare, etc.
	if (typeof import.meta !== "undefined" && import.meta.url) {
		const url = new URL(import.meta.url);
		if (url.protocol === "file:") {
			// Node/Bun/Local
			const { dirname } = getRequire()("node:path");
			const { fileURLToPath } = getRequire()("node:url");
			return dirname(fileURLToPath(import.meta.url));
		}
		// Remote/Edge (Cloudflare, etc.)
		// Strip the filename from the URL path
		const path = url.pathname;
		return path.substring(0, path.lastIndexOf("/"));
	}

	return "";
};

/**
 * Gets the current platform section name
 */
export const getPlatform = (): "linux" | "windows" => {
	const runtime = detectRuntime();
	let plat: string;
	if (runtime === "deno") {
		plat = Deno.build.os;
	} else {
		plat = process.platform;
	}
	return plat === "win32" || plat === "windows" ? "windows" : "linux";
};

/**
 * Gets the environment mode from NODE_ENV
 */
export const getMode = (): "development" | "production" => {
	const env = getEnv("NODE_ENV")?.toLowerCase();
	return env === "production" ? "production" : "development";
};

export const getTempDir = (): string => {
	if (detectRuntime() === "deno") {
		return Deno.env.get("TMPDIR") || Deno.env.get("TEMP") || "/tmp";
	} else {
		const os = getRequire()("node:os");
		return os.tmpdir();
	}
};

/**
 * Pauses execution for a specified number of milliseconds.
 *
 * @param {number} ms - The number of milliseconds to wait.
 * @returns {Promise<void>} A promise that resolves after the delay.
 */
export const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
