// =============================================
// FILE: ts-core/src/loggers/implementations/bun.ts
// PURPOSE: Bun-specific logger implementation – loads common (pino)
// =============================================

import pino from "pino";
import { type StrictLogger, StrictLoggerWrapper } from "../common";

const pinoInstance = pino({
	level: process.env.LOG_LEVEL || "info",
	redact: ["password", "secret", "token", "authorization", "apiKey"],
});

const logger: StrictLogger = new StrictLoggerWrapper(pinoInstance);

export default logger;
