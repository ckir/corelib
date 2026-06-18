import { describe, expect, it } from "vitest";
import { getRequestId, runInRequest } from "./request-context";

describe("RequestContext", () => {
	it("exposes the rid inside runInRequest and clears it outside", async () => {
		expect(getRequestId()).toBeUndefined();

		await runInRequest(42, async () => {
			expect(getRequestId()).toBe(42);
		});

		expect(getRequestId()).toBeUndefined();
	});

	it("isolates the rid across concurrently-running requests", async () => {
		const seen: Array<number | undefined> = [];

		await Promise.all([
			runInRequest(1, async () => {
				// Yield so the second request interleaves before this one reads its rid.
				await new Promise((r) => setTimeout(r, 5));
				seen.push(getRequestId());
			}),
			runInRequest(2, async () => {
				seen.push(getRequestId());
			}),
		]);

		expect(seen.sort()).toEqual([1, 2]);
	});
});
