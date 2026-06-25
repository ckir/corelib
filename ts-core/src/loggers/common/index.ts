// ts-core/src/loggers/common/index.ts

import type { Logger as PinoLogger } from "pino";
import { getSysInfo } from "../../utils/SysInfo";
import { normalizeExtras } from "./normalize-extras";

declare global {
	/**
	 * Global logger instance, if available.
	 */
	var logger: StrictLogger | undefined;
}

/**
 * Method signature for all log levels.
 *
 * @param {string} msg - The log message.
 * @param {Record<string, unknown>} [extras] - Optional metadata to include with the log entry.
 */
export type LogMethod = (msg: string, extras?: Record<string, unknown>) => void;

/**
 * StrictLogger Interface
 * Defines a consistent API across all runtimes (Node, Bun, Deno, Cloudflare, etc.)
 * This ensures that logging behavior is predictable and uniform regardless of the deployment target.
 */
export interface StrictLogger {
	/** Logs at the 'trace' level (most verbose). */
	trace: LogMethod;
	/** Logs at the 'debug' level. */
	debug: LogMethod;
	/** Logs at the 'info' level (default). */
	info: LogMethod;
	/** Logs at the 'warn' level. */
	warn: LogMethod;
	/** Logs at the 'error' level. */
	error: LogMethod;
	/** Logs at the 'fatal' level (highest priority). */
	fatal: LogMethod;

	/**
	 * Creates a child logger with additional bindings.
	 * Child loggers inherit the parent's configuration but add their own metadata.
	 *
	 * @param {Record<string, unknown>} bindings - Metadata to bind to all logs from the child logger.
	 * @returns {StrictLogger} A new logger instance.
	 */
	child: (bindings: Record<string, unknown>) => StrictLogger;

	/**
	 * Enables or disables system telemetry injection in log entries.
	 *
	 * @param {"on" | "off"} mode - The telemetry mode.
	 */
	setTelemetry: (mode: "on" | "off") => void;

	/** Current log level as a string (e.g., 'info', 'debug'). */
	level: string;
	/** Current log level as a numeric value. */
	levelVal: number;

	/**
	 * Returns the current bindings of the logger.
	 * @returns {Record<string, unknown>} The current bindings.
	 */
	bindings: () => Record<string, unknown>;

	/**
	 * Sets the log level to 'silent', disabling all output.
	 */
	silent: () => void;

	/**
	 * Flush any buffered log output (e.g. pino's sonic-boom buffer).
	 * Safe to call as a no-op when no buffer is in use.
	 *
	 * @param {(err?: Error | null) => void} [cb] - Optional callback called after flushing.
	 */
	flush: (cb?: (err?: Error | null) => void) => void;
}

/**
 * StrictLoggerWrapper
 * Wraps a standard Pino instance to enforce the StrictLogger interface
 * and inject system telemetry when enabled.
 */
const TELEMETRY_CACHE_TTL_MS = 5_000;

/**
 * Implementation of StrictLogger that wraps a Pino instance.
 * Provides consistent behavior and automatic telemetry injection.
 */
export class StrictLoggerWrapper implements StrictLogger {
	private pinoInstance: PinoLogger;
	private state: { telemetryEnabled: boolean };
	private context: Record<string, unknown>;
	private telemetryCache: {
		value: ReturnType<typeof getSysInfo>;
		expiresAt: number;
	} | null = null;

	constructor(
		pinoInstance: PinoLogger,
		state: { telemetryEnabled: boolean } = { telemetryEnabled: false },
		context: Record<string, unknown> = {},
	) {
		this.pinoInstance = pinoInstance;
		this.state = state;
		this.context = context;
	}

	private getTelemetry() {
		if (!this.state.telemetryEnabled) return undefined;
		const now = Date.now();
		if (!this.telemetryCache || now >= this.telemetryCache.expiresAt) {
			this.telemetryCache = {
				value: getSysInfo(),
				expiresAt: now + TELEMETRY_CACHE_TTL_MS,
			};
		}
		return this.telemetryCache.value;
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

	trace(msg: string, extras?: Record<string, unknown>) {
		this.validate(msg, extras);
		this.pinoInstance.trace(
			{ ...this.context, ...normalizeExtras(extras), telemetry: this.getTelemetry() },
			msg,
		);
	}
	debug(msg: string, extras?: Record<string, unknown>) {
		this.validate(msg, extras);
		this.pinoInstance.debug(
			{ ...this.context, ...normalizeExtras(extras), telemetry: this.getTelemetry() },
			msg,
		);
	}
	info(msg: string, extras?: Record<string, unknown>) {
		this.validate(msg, extras);
		this.pinoInstance.info(
			{ ...this.context, ...normalizeExtras(extras), telemetry: this.getTelemetry() },
			msg,
		);
	}
	warn(msg: string, extras?: Record<string, unknown>) {
		this.validate(msg, extras);
		this.pinoInstance.warn(
			{ ...this.context, ...normalizeExtras(extras), telemetry: this.getTelemetry() },
			msg,
		);
	}
	error(msg: string, extras?: Record<string, unknown>) {
		this.validate(msg, extras);
		this.pinoInstance.error(
			{ ...this.context, ...normalizeExtras(extras), telemetry: this.getTelemetry() },
			msg,
		);
	}
	fatal(msg: string, extras?: Record<string, unknown>) {
		this.validate(msg, extras);
		this.pinoInstance.fatal(
			{ ...this.context, ...normalizeExtras(extras), telemetry: this.getTelemetry() },
			msg,
		);
	}

	child(bindings: Record<string, unknown>): StrictLogger {
		// share same pinoInstance and same state to ensure non-independence
		return new StrictLoggerWrapper(this.pinoInstance, this.state, {
			...this.context,
			...bindings,
		});
	}

	setTelemetry(mode: "on" | "off"): void {
		if (mode !== "on" && mode !== "off") {
			throw new Error("setTelemetry accepts only 'on' or 'off'");
		}
		this.state.telemetryEnabled = mode === "on";
	}

	get level() {
		return this.pinoInstance.level;
	}
	set level(val: string) {
		this.pinoInstance.level = val;
	}
	get levelVal() {
		return this.pinoInstance.levelVal;
	}

	bindings(): Record<string, unknown> {
		return { ...this.context };
	}

	silent(): void {
		this.pinoInstance.level = "silent";
	}

	flush(cb?: (err?: Error | null) => void): void {
		if (typeof this.pinoInstance.flush === "function") {
			this.pinoInstance.flush(cb);
		} else {
			cb?.();
		}
	}
}

// FIX: Added default export so 'import logger from "../common"' works in implementations
export default StrictLoggerWrapper;
