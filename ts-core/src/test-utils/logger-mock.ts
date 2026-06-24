import { type Mock, vi } from "vitest";
import type { StrictLogger } from "../loggers/common";

export type MockLogger = {
	trace: Mock;
	debug: Mock;
	info: Mock;
	warn: Mock;
	error: Mock;
	fatal: Mock;
	child: Mock;
	setTelemetry: Mock;
	silent: Mock;
	flush: Mock;
	bindings: Mock;
	level: string;
	levelVal: number;
};

/**
 * A complete StrictLogger mock for tests. All six levels are vi.fn()s and
 * `child()` returns the SAME mock, so trace/debug calls added by §12
 * instrumentation never throw "x is not a function". Use everywhere a test
 * mocks `@ckirg/corelib`'s logger (see AGENTS.md §11/§12).
 */
export function createMockLogger(): MockLogger {
	const mock = {
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn(() => mock),
		setTelemetry: vi.fn(),
		silent: vi.fn(),
		flush: vi.fn(),
		bindings: vi.fn(() => ({})),
		level: "trace",
		levelVal: 10,
	} as MockLogger;
	return mock;
}

/** Assert the StrictLogger type is satisfied at compile time (no runtime cost). */
export const _typecheck: StrictLogger =
	createMockLogger() as unknown as StrictLogger;
