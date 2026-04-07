// ts-core/src/loggers/implementations/lambda.ts
import pino from "pino";
import pinoLambda from "pino-lambda";
import { type StrictLogger, StrictLoggerWrapper } from "../common";

export default function createLambdaLogger(): StrictLogger {
	// Handle multiple possible export shapes for pino-lambda
	const lambdaFnRaw: any = pinoLambda;
	const lambdaFn =
		typeof lambdaFnRaw === "function"
			? lambdaFnRaw
			: lambdaFnRaw.default || lambdaFnRaw.pinoLambda;

	let destination: any;
	if (typeof lambdaFn === "function") {
		try {
			destination = lambdaFn();
		} catch (_e) {
			// Fallback if destination creation fails (e.g., in some test environments)
			console.warn("pino-lambda destination creation failed, using default");
		}
	}

	const logger = pino(
		{
			level: process.env.LOG_LEVEL || "info",
			timestamp: pino.stdTimeFunctions.isoTime,
			redact: ["password", "secret", "token", "authorization"],
		},
		destination,
	);

	return new StrictLoggerWrapper(logger);
}
