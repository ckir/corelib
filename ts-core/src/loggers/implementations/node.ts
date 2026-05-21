// =============================================
// FILE: ts-core/src/loggers/implementations/node.ts
// PURPOSE: Node-specific logger implementation - loads common (pino)
// =============================================

import { Writable } from "node:stream";
import pino from "pino";
import pretty from "pino-pretty";
import { type StrictLogger, StrictLoggerWrapper } from "../common";

const isPretty =
	process.env.LOG_PRETTY === "true" ||
	(process.env.NODE_ENV !== "production" && process.env.LOG_PRETTY !== "false");

const level = process.env.LOG_LEVEL || "info";

// Proxy stream: receives raw pino NDJSON and forwards to globalThis.__wsLogWrite
// when registered by installLogTransport(). No-op until then.
const wsProxy = new Writable({
	write(
		chunk: Buffer | string,
		_encoding: BufferEncoding,
		cb: () => void,
	): void {
		const fn = (globalThis as Record<string, unknown>).__wsLogWrite as
			| ((line: string) => void)
			| undefined;
		if (fn) fn(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
		cb();
	},
});

const dest = pino.multistream([
	{
		level,
		stream: isPretty
			? pretty({
					colorize: true,
					translateTime: "SYS:standard",
					ignore: "pid,hostname",
				})
			: process.stdout,
	},
	{ level, stream: wsProxy },
]);

const pinoInstance = pino(
	{
		level,
		redact: ["password", "secret", "token", "authorization", "apiKey"],
	},
	dest,
);

const logger: StrictLogger = new StrictLoggerWrapper(pinoInstance);

export default logger;
