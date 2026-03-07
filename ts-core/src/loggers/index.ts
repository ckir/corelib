// =============================================
// FILE: ts-core/src/loggers/index.ts
// PURPOSE: Dynamic runtime loader
// NEW FIXES (2026-03-05):
//   • Removed explicit 'any' type for impl to let TS infer
//   • Replaced (globalThis as any) with extended type for logger
// NEW: Used declaration merging to augment global types for Window and NodeJS.Global,
//      allowing safe assignment to globalThis.logger without type assertions.
// FIXED: Changed to 'var logger' in declare global, as only 'var' declarations add properties to the global object (globalThis),
//        allowing type-safe access and assignment to globalThis.logger. 'const' or 'let' do not add to globalThis.
// =============================================

import type { Logger } from "pino";
import { detectRuntime } from "../common/runtime";

declare global {
	var logger: Logger | undefined;
}

const runtime = detectRuntime();

async function loadLogger() {
	let impl: typeof import("./implementations/node.js");
	switch (runtime) {
		case "bun":
			impl = await import("./implementations/bun.js");
			break;
		case "deno":
			impl = await import("./implementations/deno.js");
			break;
		default:
			impl = await import("./implementations/node.js");
	}
	const logger = impl.default;
	globalThis.logger = logger;
	return logger;
}

export default await loadLogger();
