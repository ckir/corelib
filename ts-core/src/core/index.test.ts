// =============================================
// FILE: ts-core/src/core/index.test.ts
// PURPOSE: Test suite for Core FFI integration
// =============================================

import { describe, expect, it } from "vitest";
import { Core, getVersion, logAndDouble } from "./index";

describe("Core FFI", () => {
	it("should return a version string", () => {
		const version = getVersion();
		expect(typeof version).toBe("string");
		expect(version.length).toBeGreaterThan(0);
	});

	it("should log and double a value", () => {
		const result = logAndDouble("Test Message", 21);
		expect(result).toBe(42);
	});

	it("should have a run method in Core object", () => {
		expect(typeof Core.run).toBe("function");
		// Verify it doesn't throw
		expect(() => Core.run()).not.toThrow();
	});
});
