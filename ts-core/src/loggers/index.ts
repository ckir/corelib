// =============================================
// FILE: ts-core/src/loggers/index.ts
// PURPOSE: Dynamic runtime loader
// NEW FIXES (2026-03-05):
//   • Removed explicit 'any' type for impl to let TS infer
//   • Replaced (globalThis as any) with extended type for logger
// =============================================

import { detectRuntime } from "../common/runtime";

const runtime = detectRuntime();

async function loadLoggers() {
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
	const { Loggers } = impl;
	(
		globalThis as typeof globalThis & { logger?: typeof Loggers.logger }
	).logger = Loggers.logger;
	return Loggers;
}

export const Loggers = await loadLoggers();
