// ts-core/src/loggers/common/index.ts

import type { Logger as PinoLogger } from "pino";
import { SysInfo } from "../../utils/SysInfo";

declare global {
	var logger: StrictLogger | undefined;
}

/**
 * Method signature for all log levels.
 */
export type LogMethod = (msg: string, extras?: Record<string, unknown>) => void;

/**
 * StrictLogger Interface
 * Defines a consistent API across all runtimes (Node, Bun, Deno, Cloudflare, etc.)
 */
export interface StrictLogger {
	trace: LogMethod;
	debug: LogMethod;
	info: LogMethod;
	warn: LogMethod;
	error: LogMethod;
	fatal: LogMethod;
	child: (bindings: Record<string, unknown>) => StrictLogger;
	setTelemetry: (mode: "on" | "off") => void;
	level: string;
	levelVal: number;
	bindings: () => Record<string, unknown>;
	silent: () => void;
}

/**
 * StrictLoggerWrapper
 * Wraps a standard Pino instance to enforce the StrictLogger interface
 * and inject system telemetry when enabled.
 */
export class StrictLoggerWrapper implements StrictLogger {
	private pinoInstance: PinoLogger;
	private state: { telemetryEnabled: boolean };
	private context: Record<string, unknown>;

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
		return this.state.telemetryEnabled ? SysInfo.get() : undefined;
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
			{ ...this.context, ...extras, telemetry: this.getTelemetry() },
			msg,
		);
	}
	debug(msg: string, extras?: Record<string, unknown>) {
		this.validate(msg, extras);
		this.pinoInstance.debug(
			{ ...this.context, ...extras, telemetry: this.getTelemetry() },
			msg,
		);
	}
	info(msg: string, extras?: Record<string, unknown>) {
		this.validate(msg, extras);
		this.pinoInstance.info(
			{ ...this.context, ...extras, telemetry: this.getTelemetry() },
			msg,
		);
	}
	warn(msg: string, extras?: Record<string, unknown>) {
		this.validate(msg, extras);
		this.pinoInstance.warn(
			{ ...this.context, ...extras, telemetry: this.getTelemetry() },
			msg,
		);
	}
	error(msg: string, extras?: Record<string, unknown>) {
		this.validate(msg, extras);
		this.pinoInstance.error(
			{ ...this.context, ...extras, telemetry: this.getTelemetry() },
			msg,
		);
	}
	fatal(msg: string, extras?: Record<string, unknown>) {
		this.validate(msg, extras);
		this.pinoInstance.fatal(
			{ ...this.context, ...extras, telemetry: this.getTelemetry() },
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
}

// FIX: Added default export so 'import logger from "../common"' works in implementations
export default StrictLoggerWrapper;
