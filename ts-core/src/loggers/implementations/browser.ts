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

// Safe env read: works in Node/Bun/Deno and gracefully falls back in browsers.
const envLevel: string =
	(typeof process !== "undefined" ? process.env?.LOG_LEVEL : undefined) ||
	"info";

class BrowserLogger implements StrictLogger {
	private readonly ctx: Record<string, unknown>;
	// Shared state object so children reflect parent level changes (non-independent).
	private readonly state: { level: string };

	constructor(
		ctx: Record<string, unknown> = {},
		state: { level: string } = { level: envLevel },
	) {
		this.ctx = ctx;
		this.state = state;
	}

	get level(): string {
		return this.state.level;
	}
	set level(val: string) {
		this.state.level = val;
	}
	get levelVal(): number {
		return LEVEL_MAP[this.state.level] ?? 30;
	}

	private emit(
		lvl: string,
		consoleFn: (...args: unknown[]) => void,
		msg: string,
		extras?: Record<string, unknown>,
	): void {
		if ((LEVEL_MAP[lvl] ?? 30) < this.levelVal) return;
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
		// Share the same state so children reflect parent level changes.
		return new BrowserLogger({ ...this.ctx, ...bindings }, this.state);
	}

	setTelemetry(_mode: "on" | "off"): void {
		// no-op: telemetry is a server-side concern
	}

	bindings(): Record<string, unknown> {
		return { ...this.ctx };
	}

	silent(): void {
		this.state.level = "silent";
	}

	flush(cb?: (err?: Error | null) => void): void {
		cb?.();
	}
}

const logger: StrictLogger = new BrowserLogger();
export default logger;
