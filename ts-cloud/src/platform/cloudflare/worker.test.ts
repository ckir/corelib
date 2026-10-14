import { describe, expect, it } from "vitest";
import type { AppEnv } from "../../core/types";
import worker from "./worker";

describe("Cloudflare worker entry", () => {
	it("serves /health through the default export and reports the cloudflare platform", async () => {
		const res = await worker.fetch(
			new Request("http://localhost/health"),
			{} as AppEnv["Bindings"],
			{} as ExecutionContext,
		);

		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string; platform: string };
		expect(body.status).toBe("ok");
		expect(body.platform).toBe("cloudflare");
	});
});
