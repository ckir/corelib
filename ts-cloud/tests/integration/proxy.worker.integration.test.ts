import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("ts-cloud worker (edge/proxy)", () => {
	it("[cloud.worker.health] responds to /health in the workerd sandbox", async () => {
		const res = await SELF.fetch("http://itest.local/health");
		expect(res.status).toBe(200);
	});
});
