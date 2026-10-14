// ts-core/src/loggers/implementations/lambda.ts
import pino, { type DestinationStream } from "pino";
import pinoLambda from "pino-lambda";
import { type StrictLogger, StrictLoggerWrapper } from "../common";

type LambdaFactory = () => DestinationStream;

export default function createLambdaLogger(): StrictLogger {
	// Handle multiple possible export shapes for pino-lambda
	const lambdaFnRaw = pinoLambda as unknown as
		| LambdaFactory
		| { default?: LambdaFactory; pinoLambda?: LambdaFactory };
	const lambdaFn =
		typeof lambdaFnRaw === "function"
			? lambdaFnRaw
			: lambdaFnRaw.default || lambdaFnRaw.pinoLambda;

	let destination: DestinationStream | undefined;
	if (typeof lambdaFn === "function") {
		try {
			destination = lambdaFn();
		} catch (e) {
			// Fallback if destination creation fails (e.g., in some test environments)
			console.warn(
				"pino-lambda destination creation failed, using default",
				e instanceof Error ? e.message : String(e),
			);
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
