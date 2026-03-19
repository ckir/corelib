import type { StrictLogger } from "@ckir/corelib";

export function createEdgeLogger(
	bindings: Record<string, unknown> = {},
): StrictLogger {
	const log = (
		level: string,
		msg: string,
		extras?: Record<string, unknown>,
	) => {
		console.log(
			JSON.stringify({
				level,
				msg,
				time: new Date().toISOString(),
				...bindings,
				...(extras ? { extras } : {}),
			}),
		);
	};

	return {
		trace: (msg, extras) => log("trace", msg, extras),
		debug: (msg, extras) => log("debug", msg, extras),
		info: (msg, extras) => log("info", msg, extras),
		warn: (msg, extras) => log("warn", msg, extras),
		error: (msg, extras) => log("error", msg, extras),
		fatal: (msg, extras) => log("fatal", msg, extras),
		child: (newBindings) => createEdgeLogger({ ...bindings, ...newBindings }),
		setTelemetry: (_mode) => {
			// Telemetry not implemented for edge logger yet
		},
		level: "info",
		levelVal: 30,
		bindings: () => bindings,
		silent: () => {},
	};
}
