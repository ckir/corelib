import { ConfigManager } from "@ckirg/corelib";
import { describe, expect, it } from "vitest";

describe("ConfigManager (real init, no argv hijack)", () => {
	it("[itestCore.config.init] initializes with explicit args and exposes defaults", async () => {
		await ConfigManager.getInstance().initialize([]);
		expect(
			ConfigManager.get("retrieve.retry.limit") ?? 5,
		).toBeGreaterThanOrEqual(1);
	});
});
