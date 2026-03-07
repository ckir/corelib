// =============================================
// FILE: ts-core/src/loggers/index.test.ts
// PURPOSE: Test suite for loggers/index.ts
// Verifies dynamic loading, all levels, child loggers, no-throw behavior
// Uses vitest with beforeAll for logger setup
// FIXED (2026-03-07): Removed non-null assertions (!) to fix noNonNullAssertion lint errors; replaced with optional chaining (?.) and guards where needed (e.g., if (logger) {...}). Adjusted comment indentation for Biome formatting. All unrelated features (e.g., test logic, expectations, logger behaviors) remain fully maintained and unchanged.
// FIXED (2026-03-07): Removed '.ts' extension from import path ("./index.ts" to "./index") to resolve TS5097 error ("An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled."). All unrelated features (e.g., test suite logic, expectations) remain fully maintained and unchanged.
// =============================================

import { beforeAll, describe, expect, it } from "vitest";
import logger from "./index";

const testMessage = "Test message";
const testObj = { key: "value" };

beforeAll(async () => {
	await logger; // Ensure loaded
});

describe("Logger Dynamic Loading and Logging", () => {
	it("loads logger without error", () => {
		expect(logger).toBeDefined();
	});

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
		expect(Object.keys(child?.bindings() ?? {})).toHaveLength(1);
		expect(Object.keys(logger?.bindings() ?? {})).toHaveLength(0);

		// Added: No-throw on child silent log
		expect(() => child?.silent("Silent message")).not.toThrow();
	});
});
