// =============================================
// FILE: ts-core/src/loggers/common/index.ts
// PURPOSE: Strict logger with telemetry (YOUR EXACT SPEC)
// - ONLY accepts: logger.info("msg", { extras? })
// - Throws clear error on any other signature
// - setTelemetry('on'|'off') – per logger / per child
// - When on: adds top-level "telemetry" sibling to "extras"
// - Telemetry refreshed on EVERY log call (SysInfo.get())
// - Secrets in env are auto-redacted
// - pino-pretty shows nested extras + telemetry naturally
// - Child loggers are fully independent
// =============================================

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
	private telemetryEnabled = false;

	constructor(pinoInstance: PinoLogger, inheritTelemetry = false) {
		this.pinoInstance = pinoInstance;
		this.telemetryEnabled = inheritTelemetry;
	}

	private getTelemetry() {
		return this.telemetryEnabled ? SysInfo.get() : undefined;
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
		this.pinoInstance.trace({ ...extras, telemetry: this.getTelemetry() }, msg);
	}
	debug(msg: string, extras?: Record<string, unknown>) {
		this.validate(msg, extras);
		this.pinoInstance.debug({ ...extras, telemetry: this.getTelemetry() }, msg);
	}
	info(msg: string, extras?: Record<string, unknown>) {
		this.validate(msg, extras);
		this.pinoInstance.info({ ...extras, telemetry: this.getTelemetry() }, msg);
	}
	warn(msg: string, extras?: Record<string, unknown>) {
		this.validate(msg, extras);
		this.pinoInstance.warn({ ...extras, telemetry: this.getTelemetry() }, msg);
	}
	error(msg: string, extras?: Record<string, unknown>) {
		this.validate(msg, extras);
		this.pinoInstance.error({ ...extras, telemetry: this.getTelemetry() }, msg);
	}
	fatal(msg: string, extras?: Record<string, unknown>) {
		this.validate(msg, extras);
		this.pinoInstance.fatal({ ...extras, telemetry: this.getTelemetry() }, msg);
	}

	child(bindings: Record<string, unknown>): StrictLogger {
		return new StrictLoggerWrapper(
			this.pinoInstance.child(bindings),
			this.telemetryEnabled,
		);
	}

	setTelemetry(mode: "on" | "off"): void {
		if (mode !== "on" && mode !== "off") {
			throw new Error("setTelemetry accepts only 'on' or 'off'");
		}
		this.telemetryEnabled = mode === "on";
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
		return this.pinoInstance.bindings();
	}

	silent(): void {
		this.pinoInstance.level = "silent";
	}
}

// FIX: Added default export so 'import logger from "../common"' works in implementations
export default StrictLoggerWrapper;
