import { describe, expect, it, vi } from "vitest";

// The facade reads the native class as `(coreFFI as any)?.FinnhubStreaming` at module load,
// so the mock MUST nest the throwing class under `coreFFI`. Finnhub imports ONLY coreFFI.
vi.mock("@ckir/corelib", () => ({
	coreFFI: {
		FinnhubStreaming: class {
			constructor() {
				throw new Error("failed to open redb: DatabaseAlreadyOpen");
			}
		},
	},
}));
// import the FACADE after the mock
import { FinnhubStreaming } from "./FinnhubStreaming";

describe("FinnhubStreaming construction error", () => {
	it("propagates a catchable error (does not abort) and preserves the cause", () => {
		expect(() => new FinnhubStreaming()).toThrow(/redb|open/i);
		try {
			new FinnhubStreaming();
		} catch (e) {
			expect((e as Error).message).toMatch(/native init failed/i);
			expect((e as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
		}
	});
});
