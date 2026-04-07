// =============================================
// FILE: ts-core/src/loggers/implementations/deno.ts
// PURPOSE: Deno-specific logger implementation – loads common (pino)
// =============================================

import pino from "pino";
import { type StrictLogger, StrictLoggerWrapper } from "../common";

const pinoInstance = pino({
	level: process.env.LOG_LEVEL || "info",
	redact: ["password", "secret", "token", "authorization", "apiKey"],
});

const logger: StrictLogger = new StrictLoggerWrapper(pinoInstance);

export default logger;
