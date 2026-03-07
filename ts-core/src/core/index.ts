// =============================================
// FILE: ts-core/src/core/index.ts
// PURPOSE: Core category – FFI integration
// Dynamic load based on runtime
// FIXED (2026-03-07): Replaced 'any' type for ffi with 'unknown' to avoid noExplicitAny lint error (safer than any while maintaining dynamic nature). Organized imports alphabetically per Biome assist/source/organizeImports. All unrelated features (e.g., runtime detection, FFI loading logic) remain fully maintained and unchanged.
// =============================================

import path from "node:path"; // For node/bun
import { detectRuntime } from "../common/runtime";

const runtime = detectRuntime();
let ffi: unknown;

async function loadFFI() {
	const libPath = path.resolve(
		__dirname,
		"../../rust/target/release/corelib-rust.node",
	); // Adjust build path

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

const coreFFI = await loadFFI();

export function logAndDouble(msg: string, value: number): number {
	return coreFFI.log_and_double(msg, value);
}

export function getVersion(): string {
	return coreFFI.get_version();
}

export const Core = {
	run: () => console.log(`[CORE] Running on ${runtime} with FFI`),
};
