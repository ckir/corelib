// ts-core/src/loggers/implementations/cloudflare.ts
import type { StrictLogger } from "../common";

export default function createCloudflareLogger(): StrictLogger {
	const log = (
		level: string,
		msg: string,
		extras?: Record<string, unknown>,
	) => {
		console.log(
			JSON.stringify({
				level,
				msg,
				time: Date.now(),
				...(extras && { extras }),
			}),
		);
	};

	const logger: StrictLogger = {
		trace: (m, e) => log("trace", m, e),
		debug: (m, e) => log("debug", m, e),
		info: (m, e) => log("info", m, e),
		warn: (m, e) => log("warn", m, e),
		error: (m, e) => log("error", m, e),
		fatal: (m, e) => log("fatal", m, e),
		child: () => createCloudflareLogger(),
		setTelemetry: () => {},
		level: "info",
		levelVal: 30,
		bindings: () => ({}),
		silent: () => {
			logger.level = "silent";
		},
	};

	return logger;
}
