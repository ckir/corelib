import { ConfigManager, getMode, getTempDir, logger } from "@ckirg/corelib";
import { describe, expect, it } from "vitest";

describe("cross-package: ts-markets → ts-core real bindings", () => {
	it("[xpkg.logger.child] ts-core logger produces a child logger", () => {
		const child = logger.child({ section: "itest:xpkg" });
		expect(typeof child.info).toBe("function");
	});

	it("[xpkg.getTempDir] returns a real path", () => {
		expect(typeof getTempDir()).toBe("string");
		expect(getTempDir().length).toBeGreaterThan(0);
	});

	it("[xpkg.getMode] returns a known mode", () => {
		expect(["development", "production", "test"]).toContain(getMode());
	});

	it("[xpkg.config] ConfigManager initializes in the markets context", async () => {
		await ConfigManager.getInstance().initialize([]);
		expect(ConfigManager.get).toBeTypeOf("function");
	});
});
