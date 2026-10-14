// Pins the http(s) scheme check in fetchExternalConfig: a local file whose name
// merely starts with "http" must be read from disk, not fetched.

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigManager } from "./ConfigManager";

describe("ConfigManager.fetchExternalConfig source detection", () => {
	it("treats a relative file named httpfoo-*.json as a local file", async () => {
		const name = `httpfoo-${process.pid}-${Date.now()}.json`;
		writeFileSync(join(process.cwd(), name), JSON.stringify({ a: 1 }));
		try {
			const cm = ConfigManager.getInstance();
			const out = await (
				cm as unknown as {
					fetchExternalConfig(s: string): Promise<Record<string, unknown>>;
				}
			).fetchExternalConfig(name);
			expect(out).toEqual({ a: 1 });
		} finally {
			rmSync(join(process.cwd(), name), { force: true });
		}
	});
});
