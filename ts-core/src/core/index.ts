// =============================================
// FILE: ts-core/src/core/index.ts
// PURPOSE: Core category – FFI integration
// Dynamic load based on runtime
// FIXED (2026-03-07): Replaced 'any' type for ffi with 'unknown' to avoid noExplicitAny lint error (safer than any while maintaining dynamic nature). Organized imports alphabetically per Biome assist/source/organizeImports. Added type guards for coreFFI accesses to fix 'unknown' type errors. All unrelated features (e.g., runtime detection, FFI loading logic) remain fully maintained and unchanged.
// =============================================

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path"; // For node/bun
import { detectRuntime } from "../utils/runtime";

const runtime = detectRuntime();
const require = createRequire(import.meta.url);
let ffi: unknown;

async function loadFFI() {
	const binaryName = "corelib-rust.node";

	// We try paths relative to this file's location (src/core/index.ts or dist/index.js)
	const pathsToTry = [
		path.resolve(import.meta.dirname, binaryName), // same dir (unlikely but possible)
		path.resolve(import.meta.dirname, "..", binaryName), // parent dir (standard for dist/ -> root)
		path.resolve(import.meta.dirname, "..", "..", binaryName), // grandparent dir (standard for src/core/ -> root)
	];

	const libPath = pathsToTry.find((p) => existsSync(p));

	if (!libPath) {
		throw new Error(
			`Could not find ${binaryName} in any of: ${pathsToTry.join(", ")}`,
		);
	}

	if (runtime === "deno") {
		// Deno: Try dlopen on .node (may need --allow-ffi --unstable)
		// If fails, build plain cdylib and adjust symbols
		ffi = Deno.dlopen(libPath, {
			log_and_double: { parameters: ["buffer", "i32"], result: "i32" },
			get_version: { parameters: [], result: "buffer" },
		});
	} else {
		// Node/Bun: napi-rs via bindings
		ffi = require(libPath); // Or bindings('corelib-rust')
	}
	return ffi;
}

/** 
 * Raw FFI exports from the native binary.
 * Use with caution and proper type casting.
 */
export const coreFFI = await loadFFI();

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
	run: () => console.log(`[CORE] Running on ${runtime} with FFI`),
};
