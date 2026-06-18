// =============================================
// FILE: ts-core/src/core/index.test.ts
// PURPOSE: Test suite for Core FFI integration
// =============================================

import { describe, expect, it, vi } from "vitest";

const { mockLogger, mockDebug, mockTrace } = vi.hoisted(() => {
	const trace = vi.fn();
	const debug = vi.fn();
	const child = {
		trace,
		debug,
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		fatal: vi.fn(),
	};
	const base = {
		trace,
		debug,
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn(() => child),
	};
	return { mockLogger: base, mockDebug: debug, mockTrace: trace };
});
vi.mock("../loggers", () => ({ default: mockLogger }));

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

	it("logs §12 trace during FFI load-path resolution", () => {
		// loadFFI() ran at module import; coreLogger.trace calls were captured.
		expect(mockTrace).toHaveBeenCalledWith(
			"loadFFI: start",
			expect.objectContaining({ runtime: expect.any(String) }),
		);
		expect(mockTrace).toHaveBeenCalledWith(
			"loadFFI: resolved",
			expect.objectContaining({ found: true }),
		);
	});
});
