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

import type { Logger as PinoLogger } from "pino";
import pino from "pino";
import { SysInfo } from "../../utils/SysInfo";

declare global {
	var logger: StrictLogger | undefined;
}

export type LogMethod = (msg: string, extras?: Record<string, unknown>) => void;

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
	silent: (...args: unknown[]) => void;
}

class StrictLoggerWrapper implements StrictLogger {
	private pinoInstance: PinoLogger;
	private telemetryEnabled = false;

	constructor(pinoInstance: PinoLogger, inheritTelemetry = false) {
		this.pinoInstance = pinoInstance;
		this.telemetryEnabled = inheritTelemetry;
	}

	private enforceStrict(msg: unknown, extras?: unknown): void {
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

	private getTelemetry() {
		if (!this.telemetryEnabled) return undefined;
		return SysInfo.get(); // refreshed every single log call
	}

	private log(
		level: keyof PinoLogger,
		msg: string,
		extras?: Record<string, unknown>,
	) {
		this.enforceStrict(msg, extras);

		const telemetry = this.getTelemetry();
		const logObj: Record<string, unknown> = {};

		if (extras) logObj.extras = extras;
		if (telemetry) logObj.telemetry = telemetry;

		// @ts-expect-error - pino method access
		this.pinoInstance[level](msg, logObj);
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
		const childPino = this.pinoInstance.child(bindings);
		const childWrapper = new StrictLoggerWrapper(
			childPino,
			this.telemetryEnabled,
		);
		return childWrapper;
	}

	setTelemetry(mode: "on" | "off") {
		if (mode !== "on" && mode !== "off") {
			throw new Error(`setTelemetry accepts only 'on' or 'off', got: ${mode}`);
		}
		this.telemetryEnabled = mode === "on";
	}

	// Expose Pino properties required by tests
	get level() {
		return this.pinoInstance.level;
	}
	set level(v: string) {
		this.pinoInstance.level = v;
	}
	get levelVal() {
		return (this.pinoInstance as any).levelVal;
	}
	bindings() {
		return this.pinoInstance.bindings() as Record<string, unknown>;
	}
	silent(...args: unknown[]) {
		// @ts-expect-error - pino internal
		return this.pinoInstance.silent(...args);
	}
}

const transport = pino.transport({
	targets: [{ level: "trace", target: "pino-pretty" }],
});

const basePino = pino({ level: process.env.LOG_LEVEL || "info" }, transport);

globalThis.logger = new StrictLoggerWrapper(basePino);

export default globalThis.logger;
