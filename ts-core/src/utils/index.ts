// =============================================
// FILE: ts-core/src/utils/index.ts
// PURPOSE: Utils category – exported as named import
// Example: import { Utils, SysInfo } from '@ckirg/corelib'
// NEW: Re-exports SysInfo for telemetry
// NEW: Multi-runtime abstractions for env, file, cwd, dirname
// NEW: Added getPlatform and getMode from ConfigUtils
// =============================================

import "../types/edge-runtime";
import logger from "../loggers";
import { detectRuntime } from "./runtime";

let _createRequire: ((id: string) => unknown) | undefined;
if (typeof __EDGE_RUNTIME__ === "undefined" || !__EDGE_RUNTIME__) {
	_createRequire = (await import("node:module")).createRequire;
}

const utilsLogger = logger.child({ section: "Utils" });

let _require: any;

/**
 * Gets a `require` function suitable for the current runtime.
 * In Node-like runtimes, it uses `createRequire`. In other runtimes, it returns a function that throws.
 * @returns {Function} The require function.
 */
export const getRequire = () => {
	if (!_require) {
		const runtime = detectRuntime();

		// 1. Try createRequire from node:module (Standard ESM way)
		if (
			_createRequire &&
			typeof import.meta !== "undefined" &&
			import.meta.url
		) {
			try {
				_require = _createRequire(import.meta.url);
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

export { includeExcludeCron } from "./cron";
export { type FlightRecorderExtras, nextCid } from "./flight-recorder";
export { detectRuntime, type Runtime } from "./runtime";
export { getSysInfo } from "./SysInfo";

/**
 * General utility methods.
 */
export const Utils = {
	/**
	 * Logs the current runtime information.
	 */
	run: () => utilsLogger.info(`Running on ${detectRuntime()}`),
};

/**
 * Gets an environment variable value in a runtime-agnostic way.
 * Supports Node.js (`process.env`) and Deno (`Deno.env`).
 * @param {string} key - The environment variable name.
 * @returns {string | undefined} The value of the environment variable, or undefined if not set.
 */
export const getEnv = (key: string): string | undefined => {
	try {
		if (typeof Deno !== "undefined" && Deno.env) {
			return Deno.env.get(key);
		}
	} catch {
		// Fallback to process if Deno.env access fails
	}
	try {
		if (typeof process !== "undefined" && process.env) {
			return process.env[key];
		}
	} catch {
		// Fallback to undefined
	}
	return undefined;
};

/**
 * Gets all environment variables as a record.
 * Supports Node.js and Deno.
 * @returns {Record<string, string | undefined>} An object containing all environment variables.
 */
export const getAllEnv = (): Record<string, string | undefined> => {
	try {
		if (typeof Deno !== "undefined" && Deno.env) {
			return Deno.env.toObject();
		}
	} catch {
		// Fallback to process if Deno.env access fails
	}
	try {
		if (typeof process !== "undefined" && process.env) {
			return { ...process.env };
		}
	} catch {
		// Fallback to empty object
	}
	return {};
};

/**
 * Reads a text file synchronously in a runtime-agnostic way.
 * @param {string} file - The path to the file.
 * @returns {string} The contents of the file as a string.
 */
export const readTextFileSync = (file: string): string => {
	if (typeof Deno !== "undefined" && Deno.readTextFileSync) {
		return Deno.readTextFileSync(file);
	}
	const { readFileSync } = getRequire()("node:fs");
	return readFileSync(file, "utf8");
};

/**
 * Checks if a file or directory exists synchronously.
 * @param {string} file - The path to the file or directory.
 * @returns {boolean} True if it exists, false otherwise.
 */
export const existsSync = (file: string): boolean => {
	if (typeof Deno !== "undefined" && Deno.statSync) {
		try {
			Deno.statSync(file);
			return true;
		} catch {
			return false;
		}
	}
	const { existsSync } = getRequire()("node:fs");
	return existsSync(file);
};

/**
 * Gets the current working directory in a runtime-agnostic way.
 * @returns {string} The current working directory path.
 */
export const getCwd = (): string => {
	if (typeof Deno !== "undefined" && Deno.cwd) {
		return Deno.cwd();
	}
	if (typeof process !== "undefined" && process.cwd) {
		return process.cwd();
	}
	return "/";
};

/**
 * Gets the directory name of the current module.
 * Handles `file:` URLs and edge runtimes.
 * @returns {string} The directory name.
 */
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
 * Gets the current platform section name.
 * @returns {"linux" | "windows"} The platform identifier.
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
 * Gets the environment mode from `NODE_ENV`.
 * Defaults to 'development' if not set to 'production'.
 * @returns {"development" | "production"} The environment mode.
 */
export const getMode = (): "development" | "production" => {
	const env = getEnv("NODE_ENV")?.toLowerCase();
	return env === "production" ? "production" : "development";
};

/**
 * Gets the path to the system temporary directory.
 * @returns {string} The temporary directory path.
 */
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
export const sleep = (ms: number): Promise<void> =>
	new Promise((res) => setTimeout(res, ms));
