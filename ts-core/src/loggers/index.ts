// =============================================
// FILE: ts-core/src/loggers/index.ts
// PURPOSE: Dynamic runtime loader
// (Global type is now defined in common/index.ts)
// =============================================

import { detectRuntime } from "../utils/runtime";
import type { StrictLogger } from "./common";

declare global {
	var logger: StrictLogger | undefined;
}

const runtime = detectRuntime();

async function loadLogger() {
	let impl: any;
	switch (runtime) {
		case "bun":
			impl = await import("./implementations/bun.js");
			break;
		case "deno":
			impl = await import("./implementations/deno.js");
			break;
		case "cloudflare":
			impl = await import("./implementations/cloudflare.js");
			break;
		case "aws-lambda":
			impl = await import("./implementations/lambda.js");
			break;
		case "gcp-cloudrun":
			impl = await import("./implementations/gcp.js");
			break;
		default:
			impl = await import("./implementations/node.js");
	}

	const loggerRaw = impl.default;
	const logger: StrictLogger =
		typeof loggerRaw === "function" ? loggerRaw() : loggerRaw;

	globalThis.logger = logger;
	return logger;
}

export default await loadLogger();
