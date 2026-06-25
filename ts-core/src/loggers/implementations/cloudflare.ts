// ts-core/src/loggers/implementations/cloudflare.ts

import { getSysInfo } from "../../utils/SysInfo";
import type { StrictLogger } from "../common";
import { normalizeExtras } from "../common/normalize-extras";

const LEVEL_MAP: Record<string, number> = {
	trace: 10,
	debug: 20,
	info: 30,
	warn: 40,
	error: 50,
	fatal: 60,
	silent: Infinity,
};

/**
 * Cloudflare-specific logger implementation.
 * Does not use Pino to ensure maximum compatibility with Cloudflare Workers.
 * Follows the StrictLogger interface and "not independent" child rules.
 */
class CloudflareLogger implements StrictLogger {
	private state: { telemetryEnabled: boolean };
	private context: Record<string, unknown>;
	private _level = process.env.LOG_LEVEL || "info";

	constructor(
		state: { telemetryEnabled: boolean } = { telemetryEnabled: false },
		context: Record<string, unknown> = {},
	) {
		this.state = state;
		this.context = context;
	}

	private getTelemetry() {
		return this.state.telemetryEnabled ? getSysInfo() : undefined;
	}

	private validate(msg: unknown, extras?: unknown) {
		if (typeof msg !== "string") {
			throw new Error(
				"Logger requires string message first, optional object second",
			);
		}
		if (
			extras !== undefined &&
			(typeof extras !== "object" || extras === null || Array.isArray(extras))
		) {
			throw new Error(
				"Logger requires string message first, optional object second",
			);
		}
	}

	private log(level: string, msg: string, extras?: Record<string, unknown>) {
		if ((LEVEL_MAP[level] ?? 30) < this.levelVal) return;
		this.validate(msg, extras);

		const output = {
			level,
			time: Date.now(),
			...this.context,
			...normalizeExtras(extras),
			...(this.state.telemetryEnabled && { telemetry: this.getTelemetry() }),
			msg,
		};
		console.log(JSON.stringify(output));
	}

	trace(msg: string, extras?: Record<string, unknown>) {
		this.log("trace", msg, extras);
	}
	debug(msg: string, extras?: Record<string, unknown>) {
		this.log("debug", msg, extras);
	}
	info(msg: string, extras?: Record<string, unknown>) {
		this.log("info", msg, extras);
	}
	warn(msg: string, extras?: Record<string, unknown>) {
		this.log("warn", msg, extras);
	}
	error(msg: string, extras?: Record<string, unknown>) {
		this.log("error", msg, extras);
	}
	fatal(msg: string, extras?: Record<string, unknown>) {
		this.log("fatal", msg, extras);
	}

	child(bindings: Record<string, unknown>): StrictLogger {
		// Share the same state object to ensure children are not independent
		return new CloudflareLogger(this.state, { ...this.context, ...bindings });
	}

	setTelemetry(mode: "on" | "off"): void {
		if (mode !== "on" && mode !== "off") {
			throw new Error("setTelemetry accepts only 'on' or 'off'");
		}
		this.state.telemetryEnabled = mode === "on";
	}

	get level() {
		return this._level;
	}
	set level(val: string) {
		this._level = val;
	}
	get levelVal() {
		return LEVEL_MAP[this._level] ?? 30;
	}

	bindings(): Record<string, unknown> {
		return { ...this.context };
	}

	silent(): void {
		this._level = "silent";
	}

	flush(cb?: (err?: Error | null) => void): void {
		cb?.();
	}
}

export default function createCloudflareLogger(): StrictLogger {
	return new CloudflareLogger();
}
