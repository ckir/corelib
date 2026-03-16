// =============================================
// FILE: ts-core/src/configs/ConfigManager.test.ts
// PURPOSE: Test suite for ConfigManager including On-Demand loading
// =============================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "./ConfigManager";

describe("ConfigManager", () => {
	let cm: ConfigManager;

	beforeEach(() => {
		cm = ConfigManager.getInstance();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("should be a singleton", () => {
		const instance1 = ConfigManager.getInstance();
		const instance2 = ConfigManager.getInstance();
		expect(instance1).toBe(instance2);
	});

	it("should provide static get method", () => {
		expect(typeof ConfigManager.get).toBe("function");
	});

	it("should allow updating and getting values", () => {
		cm.updateValue("test.key", "test-value");
		expect(cm.get("test.key")).toBe("test-value");
		expect(ConfigManager.get("test.key")).toBe("test-value");
	});

	it("should return undefined for non-existent keys", () => {
		expect(ConfigManager.get("non.existent.key")).toBeUndefined();
	});

	describe("loadExternalConfig (On-Demand Loading)", () => {
		it("should fetch, merge config, and emit 'configLoaded' event", async () => {
			// Mock the private fetchExternalConfig to return a predictable object
			const fetchSpy = vi
				.spyOn(cm as any, "fetchExternalConfig")
				.mockResolvedValue({
					commonAll: { dynamicKey: "dynamicValue" },
				});

			const emitSpy = vi.spyOn(cm, "emit");

			await cm.loadExternalConfig("https://example.com/config.json");

			// Verify fetch logic was triggered
			expect(fetchSpy).toHaveBeenCalledWith("https://example.com/config.json");

			// Verify the value was merged into the active config
			expect(cm.get("dynamicKey")).toBe("dynamicValue");

			// Verify the global object was updated
			expect((globalThis as any).sysconfig.dynamicKey).toBe("dynamicValue");

			// Verify the event was emitted
			expect(emitSpy).toHaveBeenCalledWith("configLoaded", expect.any(Object));
		});

		it("should maintain environment variable precedence over newly loaded files", async () => {
			// Simulate a CORELIB_ environment variable being set
			process.env.CORELIB_OVERRIDE_KEY = "env-wins";

			// Mock the external file trying to set the same key
			vi.spyOn(cm as any, "fetchExternalConfig").mockResolvedValue({
				commonAll: { override: { key: "file-loses" } },
			});

			await cm.loadExternalConfig("mock-source.json");

			// The environment variable must take priority
			expect(cm.get("override.key")).toBe("env-wins");

			delete process.env.CORELIB_OVERRIDE_KEY;
		});

		it("should throw and log if fetching fails", async () => {
			const error = new Error("Network timeout");
			vi.spyOn(cm as any, "fetchExternalConfig").mockRejectedValue(error);
			const logErrorSpy = vi
				.spyOn(cm as any, "logError")
				.mockImplementation(() => {});

			await expect(cm.loadExternalConfig("bad-url.json")).rejects.toThrow(
				"Network timeout",
			);

			expect(logErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining("Failed to load external config"),
				error,
			);
		});
	});
});
