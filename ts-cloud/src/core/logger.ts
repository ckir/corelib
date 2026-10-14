import type { StrictLogger } from "@ckirg/corelib";

/** Numeric severity per level; a message is emitted when its value >= the logger's level value. */
const LEVELS = {
	trace: 10,
	debug: 20,
	info: 30,
	warn: 40,
	error: 50,
	fatal: 60,
	silent: 100,
} as const;

type LevelName = keyof typeof LEVELS;

/** Reads LOG_LEVEL from process.env (when available); unknown or unset values fall back to 'info'. */
function levelFromEnv(): LevelName {
	const raw =
		typeof process !== "undefined" ? process.env?.LOG_LEVEL : undefined;
	const name = raw?.trim().toLowerCase();
	return name && name in LEVELS ? (name as LevelName) : "info";
}

/**
 * Minimal JSON-lines logger for edge runtimes. Honours LOG_LEVEL
 * (trace < debug < info < warn < error < fatal < silent, default info).
 * Children inherit the parent's current level and telemetry mode.
 */
export function createEdgeLogger(
	bindings: Record<string, unknown> = {},
	initial: { level?: LevelName; telemetry?: boolean } = {},
): StrictLogger {
	let level: LevelName = initial.level ?? levelFromEnv();
	let telemetry = initial.telemetry ?? false;

	const log = (
		name: Exclude<LevelName, "silent">,
		msg: string,
		extras?: Record<string, unknown>,
	) => {
		if (LEVELS[name] < LEVELS[level]) return;
		const uptimeS =
			telemetry && typeof process !== "undefined"
				? process.uptime?.()
				: undefined;
		// Sink: the only console output in ts-cloud (no biome rule flags it).
		console.log(
			JSON.stringify({
				level: name,
				msg,
				time: new Date().toISOString(),
				...bindings,
				...(extras ? { extras } : {}),
				...(uptimeS !== undefined ? { telemetry: { uptimeS } } : {}),
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
		child: (newBindings) =>
			createEdgeLogger({ ...bindings, ...newBindings }, { level, telemetry }),
		setTelemetry: (mode) => {
			if (mode !== "on" && mode !== "off") {
				throw new Error("setTelemetry accepts only 'on' or 'off'");
			}
			telemetry = mode === "on";
		},
		get level() {
			return level;
		},
		get levelVal() {
			return LEVELS[level];
		},
		bindings: () => bindings,
		silent: () => {
			level = "silent";
		},
		flush: (cb) => {
			cb?.();
		},
	};
}
