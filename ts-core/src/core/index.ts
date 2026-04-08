// =============================================
// FILE: ts-core/src/core/index.ts
// PURPOSE: Core category – FFI integration
// Dynamic load based on runtime
// FIXED (2026-03-07): Replaced 'any' type for ffi with 'unknown' to avoid noExplicitAny lint error (safer than any while maintaining dynamic nature). Organized imports alphabetically per Biome assist/source/organizeImports. Added type guards for coreFFI accesses to fix 'unknown' type errors. All unrelated features (e.g., runtime detection, FFI loading logic) remain fully maintained and unchanged.
// =============================================

import { createRequire } from "node:module";
import { detectRuntime } from "../utils/runtime";

const runtime = detectRuntime();
let _require: any;

const getRequire = () => {
	if (!_require) {
		// createRequire(import.meta.url) crashes in Cloudflare Workers if import.meta.url is undefined
		if (
			(runtime === "node" || runtime === "bun") &&
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

async function loadFFI() {
	if (runtime === "cloudflare") {
		return null; // FFI not supported/needed on Cloudflare Workers for now
	}

	const binaryName = "corelib-rust.node";

	// We try paths relative to this file's location (src/core/index.ts or dist/index.js)
	const pathsToTry: string[] = [];
	if (typeof import.meta !== "undefined" && import.meta.url) {
		try {
			pathsToTry.push(new URL(`./${binaryName}`, import.meta.url).pathname);
		} catch (_e) {
			// Ignore if URL is invalid (e.g. in some bundled environments)
		}
	}

	if (runtime !== "deno") {
		try {
			const path = getRequire()("node:path");
			const dirname = (import.meta as any).dirname;
			if (dirname) {
				pathsToTry.push(
					path.resolve(dirname, binaryName),
					path.resolve(dirname, "..", binaryName),
					path.resolve(dirname, "..", "..", binaryName),
				);
			}
			pathsToTry.push(
				path.resolve(process.cwd(), binaryName), // same dir (unlikely but possible)
				path.resolve(process.cwd(), "..", binaryName), // parent dir (standard for dist/ -> root)
				path.resolve(process.cwd(), "..", "..", binaryName), // grandparent dir (standard for src/core/ -> root)
			);
		} catch (_e) {
			// Ignore if path/fs/os can't be required (e.g. in edge runtimes)
		}
	}

	let libPath: string | undefined;
	try {
		const { existsSync } = getRequire()("node:fs");
		libPath = pathsToTry.find((p) => existsSync(p));
	} catch (_e) {
		// Ignore
	}

	if (!libPath) {
		// Instead of throwing, we return null so the package can still be used without FFI features
		console.warn(
			`[CORE] Could not find ${binaryName}. FFI features will be disabled.`,
		);
		return null;
	}

	try {
		let ffi: unknown;
		if (runtime === "deno") {
			// Deno: Try dlopen on .node (may need --allow-ffi --unstable)
			// If fails, build plain cdylib and adjust symbols
			ffi = (Deno as any).dlopen(libPath, {
				log_and_double: { parameters: ["buffer", "i32"], result: "i32" },
				get_version: { parameters: [], result: "buffer" },
			});
		} else {
			// Node/Bun: napi-rs via bindings
			ffi = getRequire()(libPath); // Or bindings('corelib-rust')
		}
		return ffi;
	} catch (error) {
		console.error(`[CORE] Failed to load FFI from ${libPath}:`, error);
		return null;
	}
}

/**
 * Raw FFI exports from the native binary.
 * Use with caution and proper type casting.
 */
export const coreFFI = await loadFFI();

export function isFfiAvailable(): boolean {
	return coreFFI !== null;
}

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

export const Core = {
	isFfiAvailable,
	getVersion,
	logAndDouble,
	run: (task?: string, options?: any) => {
		console.log(`[CORE] Running on ${runtime}. FFI: ${isFfiAvailable()}`);
		if (task) {
			console.log(`[CORE] Task: ${task}`, options || "");
		}
	},
};
