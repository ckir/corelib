import { ConfigManager, endPoint } from "@ckir/corelib";
import { loadFixture } from "@itest/_harness/server";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
	await ConfigManager.getInstance().initialize([]); // bypass vitest argv (Task 1)
});

describe("RequestUnlimited (external, replay)", () => {
	it("[itestCore.endpoint.success] returns a success result with body+status for a 200", async () => {
		loadFixture("itest-core", "endpoint-success");
		const res = await endPoint<{ ok: boolean }>("https://itest.local/core/ok");
		expect(res.status).toBe("success"); // RequestResult is a discriminated union
		if (res.status === "success") {
			expect(res.value.status).toBe(200); // HTTP status on the SerializedResponse
			expect(res.value.body).toEqual({ ok: true });
		}
	});

	it("[itestCore.endpoint.retry] recovers on the 3rd try after two 504s", async () => {
		// Bound retries small so the sequential queue [504,504,200] resolves quickly.
		ConfigManager.getInstance().updateValue("retrieve.retry.limit", 3);
		loadFixture("itest-core", "endpoint-retry"); // an ARRAY fixture: [504,504,200]
		const res = await endPoint("https://itest.local/core/flaky");
		expect(res.status).toBe("success");
	});
});
