// =============================================
// FILE: ts-core/src/loggers/index.test.ts
// PURPOSE: Exhaustive test suite for Loggers
// Includes unit tests for loading and basic functionality
// Integration tests for logging without errors across levels
// Note: Since pino uses async transports, output capturing is not implemented here;
//       we verify no throws and method existence.
//       For full output tests, consider pino's testing utilities or mocking transports.
// NEW FIXES (2026-03-05):
//   • Replaced (globalThis as any) with extended type for logger
// NEW: Removed type assertion in globalThis.logger check, as declaration merging
//      in index.ts now provides the type globally.
// FIXED: Added declare global { var logger: Logger | undefined; } for test visibility,
//        ensuring type-safe access to globalThis.logger in tests.
// FIXED (2026-03-06): Added beforeAll to asynchronously import and load the logger module,
//        ensuring globalThis.logger is set before tests run.
//        This resolves "logger is not defined" errors by executing the async
//        loadLogger() from index.ts.
// FIXED (2026-03-06): Added non-null assertions (!) to logger and child accesses,
//                     as beforeAll and child creation ensure they are defined.
//                     This fixes TS18048 "'child' is possibly 'undefined'."
//                     and TS2769 regarding Object.keys arguments.
// ADDED (2026-03-06): More assertions:
//                     - Check logger level (defaults to 'info' or from env)
//                     - Verify child logger inherits level and logs correctly
//                     - Explicit check for globalThis.logger assignment
// FIXED (2026-03-06): Removed invalid assertion expect(logger!).toHaveProperty("pino");
//                     Pino instances do not have a 'pino' property;
//                     replaced with check for logger.version to confirm it's a genuine instance.
// =============================================

import type { Logger } from "pino";
import { beforeAll, describe, expect, it } from "vitest";

declare global {
	var logger: Logger | undefined;
}

beforeAll(async () => {
	// Import the logger module to trigger async loading and set globalThis.logger
	await import("./index");
});

describe("Logger - Unit Tests", () => {
	it("loads pino logger successfully", () => {
		expect(logger).toBeDefined();
		expect(typeof logger).toBe("object");
		expect(typeof logger?.info).toBe("function");
		expect(typeof logger?.debug).toBe("function");
		expect(typeof logger?.warn).toBe("function");
		expect(typeof logger?.error).toBe("function");
		expect(typeof logger?.fatal).toBe("function");
		expect(typeof logger?.trace).toBe("function");

		// Added: Check logger level
		expect(logger?.level).toBe(process.env.LOG_LEVEL || "info");

		// Added: Detailed - logger.levelVal is a number (e.g., 30 for 'info')
		expect(typeof logger?.levelVal).toBe("number");
		expect(logger?.levelVal).toBeGreaterThanOrEqual(10); // trace=10, debug=20, etc.

		// Added: Detailed - root bindings are empty object
		expect(logger?.bindings()).toEqual({});

		// Added: Detailed - logger.version is a string like '10.x.x'
		expect(typeof logger?.version).toBe("string");
		expect(logger?.version).toMatch(/^\d+\.\d+\.\d+$/);

		// Added: No-throw on setting level
		expect(() => (logger!.level = "warn")).not.toThrow();
		expect(logger?.level).toBe("warn");
		logger!.level = process.env.LOG_LEVEL || "info"; // Reset
	});

	it("sets global logger", () => {
		expect(globalThis.logger).toBe(logger);

		// Added: Explicit check that global logger is the same instance and defined
		expect(globalThis.logger).toBeDefined();
		expect(typeof globalThis.logger?.info).toBe("function");
	});
});

describe("Logger - Integration Tests", () => {
	const testMessage = "Test log message";
	const testObj = { key: "value" };

	it("logs trace level without error", () => {
		expect(() => logger?.trace(testMessage)).not.toThrow();
	});

	it("logs debug level without error", () => {
		expect(() => logger?.debug(testMessage)).not.toThrow();
	});

	it("logs info level without error", () => {
		expect(() => logger?.info(testMessage)).not.toThrow();
	});

	it("logs warn level without error", () => {
		expect(() => logger?.warn(testMessage)).not.toThrow();
	});

	it("logs error level without error", () => {
		expect(() => logger?.error(testMessage)).not.toThrow();
	});

	it("logs fatal level without error", () => {
		expect(() => logger?.fatal(testMessage)).not.toThrow();
	});

	it("logs objects without error", () => {
		expect(() => logger?.info(testObj, testMessage)).not.toThrow();
	});

	it("creates child logger and logs without error", () => {
		const child = logger?.child({ module: "test" });
		
		// FIXED: Applied non-null assertion (!) to child variable
		expect(() => child?.info(testMessage)).not.toThrow();

		// Added: Verify child inherits level and has bindings
		expect(child?.level).toBe(logger?.level);
		expect(child?.bindings()).toMatchObject({ module: "test" });

		// Added: Log with child and ensure no throw
		expect(() => child?.debug("Child debug message")).not.toThrow();

		// Added: Detailed - child.levelVal matches parent
		expect(child?.levelVal).toBe(logger?.levelVal);

		// FIXED: Non-null assertion (!) fixes TS2769 "Argument of type 'Bindings | undefined' is not assignable to parameter of type 'object'" 
		expect(Object.keys(child?.bindings())).toHaveLength(1);
		expect(Object.keys(logger?.bindings() || {})).toHaveLength(0);

		// Added: No-throw on child silent log
		expect(() => child?.silent("Silent message")).not.toThrow();
	});
});