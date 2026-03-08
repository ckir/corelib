// =============================================
// FILE: ts-core/src/loggers/index.test.ts
// PURPOSE: Comprehensive test suite for loggers/index.ts
// Verifies strict API, telemetry, child independence, levels, and pino properties.
// =============================================

import { beforeAll, describe, expect, it, vi } from "vitest";
import { SysInfo } from "../utils/SysInfo";
import logger from "./index";

const testMessage = "Test message";
const testObj = { key: "value" };

beforeAll(async () => {
	await logger; // Ensure dynamic loader finished
});

describe("Logger Implementation (StrictLoggerWrapper)", () => {
	describe("Strict API Enforcement", () => {
		it("accepts valid string message", () => {
			// biome-ignore lint/style/noNonNullAssertion: logger is loaded in beforeAll
			expect(() => logger!.info(testMessage)).not.toThrow();
		});

		it("accepts valid string message and object extras", () => {
			// biome-ignore lint/style/noNonNullAssertion: logger is loaded in beforeAll
			expect(() => logger!.info(testMessage, testObj)).not.toThrow();
		});

		it("throws when message is not a string", () => {
			// @ts-expect-error - testing invalid signature
			// biome-ignore lint/style/noNonNullAssertion: logger is loaded in beforeAll
			expect(() => logger!.info(123)).toThrow(
				"Logger requires string message first, optional object second",
			);
			// @ts-expect-error
			// biome-ignore lint/style/noNonNullAssertion: logger is loaded in beforeAll
			expect(() => logger!.info({})).toThrow(
				"Logger requires string message first, optional object second",
			);
			// @ts-expect-error
			// biome-ignore lint/style/noNonNullAssertion: logger is loaded in beforeAll
			expect(() => logger!.info(null)).toThrow(
				"Logger requires string message first, optional object second",
			);
		});

		it("throws when extras is not an object", () => {
			// @ts-expect-error - testing invalid signature
			// biome-ignore lint/style/noNonNullAssertion: logger is loaded in beforeAll
			expect(() => logger!.info(testMessage, "not an object")).toThrow(
				"Logger requires string message first, optional object second",
			);
			// @ts-expect-error
			// biome-ignore lint/style/noNonNullAssertion: logger is loaded in beforeAll
			expect(() => logger!.info(testMessage, 123)).toThrow(
				"Logger requires string message first, optional object second",
			);
		});

		it("specifically throws on null extras", () => {
			// @ts-expect-error
			// biome-ignore lint/style/noNonNullAssertion: logger is loaded in beforeAll
			expect(() => logger!.info(testMessage, null)).toThrow(
				"Logger requires string message first, optional object second",
			);
		});

		it("specifically throws on array extras", () => {
			// @ts-expect-error
			// biome-ignore lint/style/noNonNullAssertion: logger is loaded in beforeAll
			expect(() => logger!.info(testMessage, [])).toThrow(
				"Logger requires string message first, optional object second",
			);
		});
	});

	describe("Logging Levels", () => {
		const levels = [
			"trace",
			"debug",
			"info",
			"warn",
			"error",
			"fatal",
		] as const;

		for (const level of levels) {
			it(`supports ${level} level`, () => {
				// biome-ignore lint/style/noNonNullAssertion: logger is loaded in beforeAll
				expect(() => logger![level](testMessage)).not.toThrow();
			});
		}
	});

	describe("Telemetry Functionality", () => {
		it("defaults telemetry to off and does not call SysInfo.get()", () => {
			const spy = vi.spyOn(SysInfo, "get");
			// biome-ignore lint/style/noNonNullAssertion: logger is loaded in beforeAll
			logger!.info(testMessage);
			expect(spy).not.toHaveBeenCalled();
			spy.mockRestore();
		});

		it("calls SysInfo.get() when telemetry is enabled", () => {
			const spy = vi.spyOn(SysInfo, "get");
			// biome-ignore lint/style/noNonNullAssertion: logger is loaded in beforeAll
			logger!.setTelemetry("on");
			// biome-ignore lint/style/noNonNullAssertion: logger is loaded in beforeAll
			logger!.info(testMessage);
			expect(spy).toHaveBeenCalled();
			// biome-ignore lint/style/noNonNullAssertion: logger is loaded in beforeAll
			logger!.setTelemetry("off"); // Cleanup
			spy.mockRestore();
		});

		it("throws on invalid telemetry mode", () => {
			// @ts-expect-error
			// biome-ignore lint/style/noNonNullAssertion: logger is loaded in beforeAll
			expect(() => logger!.setTelemetry("invalid")).toThrow(
				"setTelemetry accepts only 'on' or 'off'",
			);
		});
	});

	describe("Child Loggers", () => {
		it("creates a child logger with bindings", () => {
			// biome-ignore lint/style/noNonNullAssertion: logger is loaded in beforeAll
			const child = logger!.child({ module: "test-module" });
			expect(child).toBeDefined();
			expect(child.bindings()).toMatchObject({ module: "test-module" });
		});

		it("child inherits telemetry setting from parent at creation", () => {
			// biome-ignore lint/style/noNonNullAssertion: logger is loaded in beforeAll
			logger!.setTelemetry("on");
			// biome-ignore lint/style/noNonNullAssertion: logger is loaded in beforeAll
			const child = logger!.child({ module: "telemetry-test" });

			const spy = vi.spyOn(SysInfo, "get");
			child.info(testMessage);
			expect(spy).toHaveBeenCalled();

			// biome-ignore lint/style/noNonNullAssertion: logger is loaded in beforeAll
			logger!.setTelemetry("off");
			spy.mockRestore();
		});

		it("child telemetry is independent from parent after creation", () => {
			// biome-ignore lint/style/noNonNullAssertion: logger is loaded in beforeAll
			const child = logger!.child({ module: "independent-test" });

			// biome-ignore lint/style/noNonNullAssertion: logger is loaded in beforeAll
			logger!.setTelemetry("on");
			child.setTelemetry("off");

			const spy = vi.spyOn(SysInfo, "get");
			child.info(testMessage);
			expect(spy).not.toHaveBeenCalled(); // Child is off even if parent is on

			// biome-ignore lint/style/noNonNullAssertion: logger is loaded in beforeAll
			logger!.info(testMessage);
			expect(spy).toHaveBeenCalled(); // Parent is still on

			// biome-ignore lint/style/noNonNullAssertion: logger is loaded in beforeAll
			logger!.setTelemetry("off");
			spy.mockRestore();
		});
	});

	describe("Pino Property Integration", () => {
		it("allows getting and setting the log level", () => {
			// biome-ignore lint/style/noNonNullAssertion: logger is loaded in beforeAll
			const originalLevel = logger!.level;
			// biome-ignore lint/style/noNonNullAssertion: logger is loaded in beforeAll
			logger!.level = "debug";
			// biome-ignore lint/style/noNonNullAssertion: logger is loaded in beforeAll
			expect(logger!.level).toBe("debug");
			// biome-ignore lint/style/noNonNullAssertion: logger is loaded in beforeAll
			logger!.level = originalLevel;
		});

		it("provides levelVal", () => {
			// biome-ignore lint/style/noNonNullAssertion: logger is loaded in beforeAll
			expect(typeof logger!.levelVal).toBe("number");
		});

		it("provides bindings", () => {
			// biome-ignore lint/style/noNonNullAssertion: logger is loaded in beforeAll
			expect(typeof logger!.bindings()).toBe("object");
		});

		it("provides a silent method", () => {
			// biome-ignore lint/style/noNonNullAssertion: logger is loaded in beforeAll
			expect(typeof logger!.silent).toBe("function");
			// biome-ignore lint/style/noNonNullAssertion: logger is loaded in beforeAll
			expect(() => logger!.silent("nothing")).not.toThrow();
		});
	});
});
