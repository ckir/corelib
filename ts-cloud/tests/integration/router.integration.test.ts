import { createRouter } from "@ckir/corelib-cloud";
import { describe, expect, it } from "vitest";

describe("ts-cloud router composition (node)", () => {
	it("[cloud.health] GET /health returns 200 through the real Hono app", async () => {
		const app = createRouter();
		const res = await app.request("http://itest.local/health");
		expect(res.status).toBe(200);
	});
});
