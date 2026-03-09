// =============================================
// FILE: ts-core/src/configs/ConfigManager.test.ts
// PURPOSE: Test suite for ConfigManager
// =============================================

import { describe, expect, it } from "vitest";
import { ConfigManager } from "./ConfigManager";

describe("ConfigManager", () => {
	it("should be a singleton", () => {
		const instance1 = ConfigManager.getInstance();
		const instance2 = ConfigManager.getInstance();
		expect(instance1).toBe(instance2);
	});

	it("should provide static get method", () => {
		expect(typeof ConfigManager.get).toBe("function");
	});

	it("should allow updating and getting values", () => {
		const cm = ConfigManager.getInstance();
		cm.updateValue("test.key", "test-value");
		expect(cm.get("test.key")).toBe("test-value");
		expect(ConfigManager.get("test.key")).toBe("test-value");
	});

	it("should return undefined for non-existent keys", () => {
		expect(ConfigManager.get("non.existent.key")).toBeUndefined();
	});
});
