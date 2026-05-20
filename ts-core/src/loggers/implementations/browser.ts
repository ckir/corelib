// Browser-compatible StrictLogger — uses console, zero Node.js dependencies.
import type { StrictLogger } from "../common/index.js";

const LEVEL_MAP: Record<string, number> = {
	trace: 10,
	debug: 20,
	info: 30,
	warn: 40,
	error: 50,
	fatal: 60,
	silent: Infinity,
};

class BrowserLogger implements StrictLogger {
	private readonly ctx: Record<string, unknown>;
	level = "info";

	constructor(ctx: Record<string, unknown> = {}) {
		this.ctx = ctx;
	}

	get levelVal(): number {
		return LEVEL_MAP[this.level] ?? 30;
	}

	private emit(
		lvl: string,
		consoleFn: (...args: unknown[]) => void,
		msg: string,
		extras?: Record<string, unknown>,
	): void {
		if (LEVEL_MAP[lvl] < this.levelVal) return;
		consoleFn(`[${lvl.toUpperCase()}]`, msg, { ...this.ctx, ...extras });
	}

	trace(msg: string, extras?: Record<string, unknown>): void {
		this.emit("trace", console.debug.bind(console), msg, extras);
	}
	debug(msg: string, extras?: Record<string, unknown>): void {
		this.emit("debug", console.debug.bind(console), msg, extras);
	}
	info(msg: string, extras?: Record<string, unknown>): void {
		this.emit("info", console.info.bind(console), msg, extras);
	}
	warn(msg: string, extras?: Record<string, unknown>): void {
		this.emit("warn", console.warn.bind(console), msg, extras);
	}
	error(msg: string, extras?: Record<string, unknown>): void {
		this.emit("error", console.error.bind(console), msg, extras);
	}
	fatal(msg: string, extras?: Record<string, unknown>): void {
		this.emit("fatal", console.error.bind(console), msg, extras);
	}

	child(bindings: Record<string, unknown>): StrictLogger {
		return new BrowserLogger({ ...this.ctx, ...bindings });
	}

	setTelemetry(_mode: "on" | "off"): void {
		// no-op: telemetry is a server-side concern
	}

	bindings(): Record<string, unknown> {
		return { ...this.ctx };
	}

	silent(): void {
		this.level = "silent";
	}
}

const logger: StrictLogger = new BrowserLogger();
export default logger;
