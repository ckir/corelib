import { describe, expect, it } from "vitest";
import { ConfigManager } from "./ConfigManager";

describe("ConfigManager.initialize(args)", () => {
	it("accepts an explicit args array and ignores process.argv", async () => {
		// Simulate Vitest hijacking argv with its own --config flag.
		const original = process.argv;
		process.argv = [
			"node",
			"vitest",
			"--config",
			"vitest.integration.config.ts",
		];
		try {
			// Passing [] must yield an empty arg set and not throw.
			await expect(
				ConfigManager.getInstance().initialize([]),
			).resolves.toBeUndefined();
		} finally {
			process.argv = original;
		}
	});
});
