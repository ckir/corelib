// ts-core/src/loggers/implementations/gcp.ts

import * as gcpConfig from "@google-cloud/pino-logging-gcp-config";
import pino from "pino";
import { type StrictLogger, StrictLoggerWrapper } from "../common";

export default function createGcpLogger(): StrictLogger {
	// Dynamically access the config factory to handle both ESM and CJS shapes
	const configFactory =
		(gcpConfig as any).createGcpLoggingPinoConfig ||
		(gcpConfig as any).default?.createGcpLoggingPinoConfig ||
		(gcpConfig as any).default;

	if (typeof configFactory !== "function") {
		throw new Error(
			"Could not find createGcpLoggingPinoConfig function in @google-cloud/pino-logging-gcp-config",
		);
	}

	const config = configFactory(
		{}, // GCP options
		{
			level: process.env.LOG_LEVEL || "info",
			timestamp: pino.stdTimeFunctions.isoTime,
			redact: ["password", "secret", "token", "authorization"],
		},
	);

	return new StrictLoggerWrapper(pino(config));
}
