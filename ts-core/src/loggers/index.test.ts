// =============================================
// FILE: ts-core/src/loggers/index.test.ts
// PURPOSE: Exhaustive test suite for Loggers
// Includes unit tests for loading and basic functionality
// Integration tests for logging without errors across levels
// Note: Since pino uses async transports, output capturing is not implemented here;
//       we verify no throws and method existence. For full output tests, consider
//       pino's testing utilities or mocking transports.
// NEW FIXES (2026-03-05):
//   • Replaced (globalThis as any) with extended type for logger
// =============================================

import { describe, expect, it } from "vitest";
import { Loggers } from ".";

describe("Loggers - Unit Tests", () => {
	it("loads pino logger successfully", () => {
		expect(Loggers).toBeDefined();
		expect(Loggers.logger).toBeDefined();
		expect(typeof Loggers.logger).toBe("object");
		expect(typeof Loggers.logger.info).toBe("function");
		expect(typeof Loggers.logger.debug).toBe("function");
		expect(typeof Loggers.logger.warn).toBe("function");
		expect(typeof Loggers.logger.error).toBe("function");
		expect(typeof Loggers.logger.fatal).toBe("function");
		expect(typeof Loggers.logger.trace).toBe("function");
	});

	it("sets global logger", () => {
		expect(
			(globalThis as typeof globalThis & { logger?: typeof Loggers.logger })
				.logger,
		).toBe(Loggers.logger);
	});
});

describe("Loggers - Integration Tests", () => {
	const testMessage = "Test log message";
	const testObj = { key: "value" };

	it("logs trace level without error", () => {
		expect(() => Loggers.logger.trace(testMessage)).not.toThrow();
	});

	it("logs debug level without error", () => {
		expect(() => Loggers.logger.debug(testMessage)).not.toThrow();
	});

	it("logs info level without error", () => {
		expect(() => Loggers.logger.info(testMessage)).not.toThrow();
	});

	it("logs warn level without error", () => {
		expect(() => Loggers.logger.warn(testMessage)).not.toThrow();
	});

	it("logs error level without error", () => {
		expect(() => Loggers.logger.error(testMessage)).not.toThrow();
	});

	it("logs fatal level without error", () => {
		expect(() => Loggers.logger.fatal(testMessage)).not.toThrow();
	});

	it("logs objects without error", () => {
		expect(() => Loggers.logger.info(testObj, testMessage)).not.toThrow();
	});

	it("creates child logger and logs without error", () => {
		const child = Loggers.logger.child({ module: "test" });
		expect(() => child.info(testMessage)).not.toThrow();
	});
});
