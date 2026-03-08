// =============================================
// FILE: ts-core/src/loggers/index.ts
// PURPOSE: Dynamic runtime loader
// (Global type is now defined in common/index.ts)
// =============================================

import { detectRuntime } from "../common/runtime";
import type { StrictLogger } from "./common";

declare global {
	var logger: StrictLogger | undefined;
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
