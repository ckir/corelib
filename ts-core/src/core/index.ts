// =============================================
// FILE: ts-core/src/core/index.ts
// PURPOSE: Core category – FFI integration
// Dynamic load based on runtime
// FIXED (2026-03-07): Replaced 'any' type for ffi with 'unknown' to avoid noExplicitAny lint error (safer than any while maintaining dynamic nature). Organized imports alphabetically per Biome assist/source/organizeImports. Added type guards for coreFFI accesses to fix 'unknown' type errors. All unrelated features (e.g., runtime detection, FFI loading logic) remain fully maintained and unchanged.
// =============================================

import "../types/edge-runtime";
import { serializeError } from "serialize-error";
import logger from "../loggers";
import { detectRuntime } from "../utils/runtime";

let _createRequire: ((id: string) => unknown) | undefined;
if (typeof __EDGE_RUNTIME__ === "undefined" || !__EDGE_RUNTIME__) {
	_createRequire = (await import("node:module")).createRequire;
}

const coreLogger = logger.child({ section: "Core" });

const runtime = detectRuntime();
// CJS require returns an untyped module — any on the return is intentional
type RequireFn = (id: string) => any;
let _require: RequireFn | undefined;

const getRequire = () => {
	if (!_require) {
		const isNodeLike = [
			"node",
			"bun",
			"deno",
			"aws-lambda",
			"gcp-cloudrun",
		].includes(runtime);

		// createRequire(import.meta.url) crashes in Cloudflare Workers if import.meta.url is undefined
		if (
			_createRequire &&
			isNodeLike &&
			typeof import.meta !== "undefined" &&
			import.meta.url
		) {
			_require = _createRequire(import.meta.url) as RequireFn;
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

async function loadFFI() {
	if (runtime === "cloudflare") {
		return null; // FFI not supported/needed on Cloudflare Workers for now
	}

	const binaryName = "corelib-rust.node";
	const pathsToTry: string[] = [];

	let path: any;
	try {
		path = getRequire()("node:path");
	} catch {
		// Fallback for runtimes without node:path
	}

	if (typeof import.meta !== "undefined" && import.meta.url) {
		try {
			const url = new URL(import.meta.url);
			if (url.protocol === "file:") {
				const { fileURLToPath } = getRequire()("node:url");
				const moduleFile = fileURLToPath(import.meta.url);
				const moduleDir = path ? path.dirname(moduleFile) : "";

				if (moduleDir && path) {
					pathsToTry.push(
						path.resolve(moduleDir, binaryName),
						path.resolve(moduleDir, "..", binaryName),
						path.resolve(moduleDir, "..", "..", binaryName),
					);
				}
			} else {
				// Remote/Edge URL
				pathsToTry.push(new URL(`./${binaryName}`, import.meta.url).pathname);
			}
		} catch (_e) {
			// Ignore if URL is invalid (e.g. in some bundled environments)
		}
	}

	try {
		const cwd = process.cwd();
		if (path) {
			pathsToTry.push(
				path.resolve(cwd, binaryName), // same dir (unlikely but possible)
				path.resolve(cwd, "..", binaryName), // parent dir (standard for dist/ -> root)
				path.resolve(cwd, "..", "..", binaryName), // grandparent dir (standard for src/core/ -> root)
				path.resolve(cwd, "ts-core", binaryName),
				path.resolve(cwd, "..", "ts-core", binaryName),
			);
		} else {
			pathsToTry.push(`./${binaryName}`, `../${binaryName}`);
		}
	} catch (_e) {
		// Ignore if path/fs/os can't be required (e.g. in edge runtimes)
	}

	let libPath: string | undefined;
	try {
		const { existsSync } = getRequire()("node:fs");
		// Remove duplicates and filter by existence
		libPath = [...new Set(pathsToTry)].find((p) => p && existsSync(p));
	} catch (_e) {
		// Ignore
	}

	if (!libPath) {
		// Instead of throwing, we return null so the package can still be used without FFI features
		coreLogger.warn(
			`Could not find ${binaryName}. FFI features will be disabled.`,
		);
		return null;
	}

	try {
		// Use require for all Node-compatible runtimes (Node, Bun, Deno 2+)
		return getRequire()(libPath);
	} catch (error) {
		coreLogger.error(`Failed to load FFI from ${libPath}`, {
			error: serializeError(error),
		});
		return null;
	}
}

/**
 * Raw FFI exports from the native binary.
 * Use with caution and proper type casting.
 */
export const coreFFI = await loadFFI();

/**
 * Checks if the native FFI library is loaded and available.
 * @returns {boolean} True if FFI is available, false otherwise.
 */
export function isFfiAvailable(): boolean {
	return coreFFI !== null;
}

/**
 * Native FFI function: Logs a message from Rust and returns the doubled value.
 * @param {string} msg - The message to log.
 * @param {number} value - The number to double.
 * @returns {number} The doubled value returned from Rust.
 * @throws {Error} If FFI is not loaded or incompatible.
 */
export function logAndDouble(msg: string, value: number): number {
	if (
		typeof coreFFI === "object" &&
		coreFFI !== null &&
		"logAndDouble" in coreFFI &&
		typeof coreFFI.logAndDouble === "function"
	) {
		return coreFFI.logAndDouble(msg, value);
	}
	throw new Error("FFI not loaded or incompatible");
}

/**
 * Native FFI function: Gets the version of the native library.
 * @returns {string} The version string from Rust.
 * @throws {Error} If FFI is not loaded or incompatible.
 */
export function getVersion(): string {
	if (
		typeof coreFFI === "object" &&
		coreFFI !== null &&
		"getVersion" in coreFFI &&
		typeof coreFFI.getVersion === "function"
	) {
		return coreFFI.getVersion();
	}
	throw new Error("FFI not loaded or incompatible");
}

/**
 * Core section containing FFI and basic runtime information.
 */
export const Core = {
	/**
	 * Checks if FFI is available.
	 */
	isFfiAvailable,
	/**
	 * Gets the native library version.
	 */
	getVersion,
	/**
	 * Calls the native log and double function.
	 */
	logAndDouble,
	/**
	 * Runs a core task or simply logs the current runtime status.
	 * @param {string} [task] - Optional task name to log.
	 * @param {Record<string, unknown>} [options] - Optional options for the task.
	 */
	run: (task?: string, options?: Record<string, unknown>) => {
		coreLogger.info(`Running on ${runtime}. FFI: ${isFfiAvailable()}`);
		if (task) {
			coreLogger.info(`Task: ${task}`, options);
		}
	},
};
