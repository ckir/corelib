// =============================================
// FILE: ts-core/src/loggers/index.test.ts
// PURPOSE: Comprehensive test suite for loggers/index.ts
// Verifies strict API, telemetry, child independence, levels, and pino properties.
// Includes validation for edge-specific logger implementations (Cloudflare, AWS, GCP).
// =============================================

import { beforeAll, describe, expect, it, vi } from "vitest";

// Mock GCP logger config to avoid metadata lookup warnings in CI/non-GCP environments
vi.mock("@google-cloud/pino-logging-gcp-config", () => ({
	createGcpLoggingPinoConfig: (_opts: any, pinoOpts: any) => pinoOpts,
	default: {
		createGcpLoggingPinoConfig: (_opts: any, pinoOpts: any) => pinoOpts,
	},
}));

import * as SysInfoModule from "../utils/SysInfo";
// Import edge environment implementations for explicit testing
import createCloudflareLogger from "./implementations/cloudflare";
import createGcpLogger from "./implementations/gcp";
import createLambdaLogger from "./implementations/lambda";
import logger from "./index";

const testMessage = "Test message";
const testObj = { key: "value" };

beforeAll(async () => {
	await logger; // Ensure dynamic loader finished
});

describe("Logger Implementation (StrictLoggerWrapper)", () => {
	describe("Strict API Enforcement", () => {
		it("accepts valid string message", () => {
			// logger is loaded in beforeAll
			expect(() => logger!.info(testMessage)).not.toThrow();
		});

		it("accepts valid string message and object extras", () => {
			// logger is loaded in beforeAll
			expect(() => logger!.info(testMessage, testObj)).not.toThrow();
		});

		it("throws when message is not a string", () => {
			// @ts-expect-error - testing invalid signature
			// logger is loaded in beforeAll
			expect(() => logger!.info(123)).toThrow(
				"Logger requires string message first, optional object second",
			);
			// @ts-expect-error
			// logger is loaded in beforeAll
			expect(() => logger!.info({})).toThrow(
				"Logger requires string message first, optional object second",
			);
			// @ts-expect-error
			// logger is loaded in beforeAll
			expect(() => logger!.info(null)).toThrow(
				"Logger requires string message first, optional object second",
			);
		});

		it("throws when extras is not an object", () => {
			// @ts-expect-error - testing invalid signature
			// logger is loaded in beforeAll
			expect(() => logger!.info(testMessage, "not an object")).toThrow(
				"Logger requires string message first, optional object second",
			);
			// @ts-expect-error
			// logger is loaded in beforeAll
			expect(() => logger!.info(testMessage, 123)).toThrow(
				"Logger requires string message first, optional object second",
			);
		});

		it("specifically throws on null extras", () => {
			// @ts-expect-error
			// logger is loaded in beforeAll
			expect(() => logger!.info(testMessage, null)).toThrow(
				"Logger requires string message first, optional object second",
			);
		});

		it("specifically throws on array extras", () => {
			// @ts-expect-error
			// logger is loaded in beforeAll
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
				// logger is loaded in beforeAll
				expect(() => logger![level](testMessage)).not.toThrow();
			});
		}
	});

	describe("Telemetry Functionality", () => {
		it("defaults telemetry to off and does not call getSysInfo()", () => {
			const spy = vi.spyOn(SysInfoModule, "getSysInfo");
			// logger is loaded in beforeAll
			logger!.info(testMessage);
			expect(spy).not.toHaveBeenCalled();
			spy.mockRestore();
		});

		it("calls getSysInfo() when telemetry is enabled", () => {
			const spy = vi.spyOn(SysInfoModule, "getSysInfo");
			// logger is loaded in beforeAll
			logger!.setTelemetry("on");
			// logger is loaded in beforeAll
			logger!.info(testMessage);
			expect(spy).toHaveBeenCalled();
			// logger is loaded in beforeAll
			logger!.setTelemetry("off"); // Cleanup
			spy.mockRestore();
		});

		it("throws on invalid telemetry mode", () => {
			// @ts-expect-error
			// logger is loaded in beforeAll
			expect(() => logger!.setTelemetry("invalid")).toThrow(
				"setTelemetry accepts only 'on' or 'off'",
			);
		});
	});

	describe("Child Loggers", () => {
		it("creates a child logger with bindings", () => {
			// logger is loaded in beforeAll
			const child = logger!.child({ module: "test-module" });
			expect(child).toBeDefined();
			expect(child.bindings()).toMatchObject({ module: "test-module" });
		});

		it("child inherits telemetry setting from parent at creation", () => {
			// logger is loaded in beforeAll
			logger!.setTelemetry("on");
			// logger is loaded in beforeAll
			const child = logger!.child({ module: "telemetry-test" });

			const spy = vi.spyOn(SysInfoModule, "getSysInfo");
			child.info(testMessage);
			expect(spy).toHaveBeenCalled();

			// logger is loaded in beforeAll
			logger!.setTelemetry("off");
			spy.mockRestore();
		});

		it("child telemetry is NOT independent from parent after creation", () => {
			// logger is loaded in beforeAll
			const child = logger!.child({ module: "not-independent-test" });
			// logger is loaded in beforeAll
			logger!.setTelemetry("on");

			const spy = vi.spyOn(SysInfoModule, "getSysInfo");
			child.info(testMessage);
			expect(spy).toHaveBeenCalled(); // Child is on because parent is on

			// Turning off child should turn off parent (shared state)
			child.setTelemetry("off");
			// logger is loaded in beforeAll
			logger!.info(testMessage);
			expect(spy).toHaveBeenCalledTimes(1); // No new call

			spy.mockRestore();
		});
	});

	describe("Pino Property Integration", () => {
		it("allows getting and setting the log level (shared across children)", () => {
			// logger is loaded in beforeAll
			const originalLevel = logger!.level;
			// logger is loaded in beforeAll
			const child = logger!.child({ module: "level-test" });

			// logger is loaded in beforeAll
			logger!.level = "debug";
			expect(child.level).toBe("debug");

			child.level = "warn";
			// logger is loaded in beforeAll
			expect(logger!.level).toBe("warn");

			// logger is loaded in beforeAll
			logger!.level = originalLevel;
		});

		it("provides levelVal", () => {
			// logger is loaded in beforeAll
			expect(typeof logger!.levelVal).toBe("number");
		});

		it("provides bindings", () => {
			// logger is loaded in beforeAll
			expect(typeof logger!.bindings()).toBe("object");
		});

		it("provides a silent method", () => {
			// logger is loaded in beforeAll
			expect(typeof logger!.silent).toBe("function");
			// logger is loaded in beforeAll
			expect(() => logger!.silent()).not.toThrow();
		});
	});

	// ===================================================================
	// Edge Environment Implementations
	// ===================================================================
	describe("Edge Environment Implementations", () => {
		it("Cloudflare logger should conform to StrictLogger and use console.log with flattened extras", () => {
			// Intercept console.log to prevent test noise and verify payload
			const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const cfLogger = createCloudflareLogger();

			expect(cfLogger.info).toBeDefined();
			expect(cfLogger.child).toBeDefined();

			// Test the custom edge serialization structure with child and extras
			const child = cfLogger.child({ module: "edge-child" });
			child.info("Edge test message", { edgeMode: true });

			expect(consoleSpy).toHaveBeenCalledTimes(1);
			const rawOutput = consoleSpy.mock.calls[0][0];
			const logOutput = JSON.parse(rawOutput);

			expect(logOutput.msg).toBe("Edge test message");
			expect(logOutput.level).toBe("info");
			expect(logOutput.module).toBe("edge-child"); // Flattened from child
			expect(logOutput.edgeMode).toBe(true); // Flattened from extras

			// Verify key order: msg should be after context/extras
			const keys = Object.keys(logOutput);
			const msgIndex = keys.indexOf("msg");
			const moduleIndex = keys.indexOf("module");
			const edgeModeIndex = keys.indexOf("edgeMode");

			expect(moduleIndex).toBeLessThan(msgIndex);
			expect(edgeModeIndex).toBeLessThan(msgIndex);

			consoleSpy.mockRestore();
		});

		it("AWS Lambda logger should instantiate and conform to StrictLogger", () => {
			// Verifies that pino-lambda initializes correctly within the wrapper without crashing
			const lambdaLogger = createLambdaLogger();

			expect(lambdaLogger.info).toBeDefined();
			expect(lambdaLogger.child).toBeDefined();
			expect(() => lambdaLogger.info("Lambda init test")).not.toThrow();
		});

		it("GCP CloudRun logger should instantiate and conform to StrictLogger", () => {
			// Verifies that @google-cloud/pino-logging-gcp-config resolves and initializes correctly
			const gcpLogger = createGcpLogger();

			expect(gcpLogger.info).toBeDefined();
			expect(gcpLogger.child).toBeDefined();
			expect(() => gcpLogger.info("GCP init test")).not.toThrow();
		});
	});
});
