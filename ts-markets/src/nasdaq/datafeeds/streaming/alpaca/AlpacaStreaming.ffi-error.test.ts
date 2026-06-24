import { describe, expect, it, vi } from "vitest";

// The facade reads the native class as `(coreFFI as any)?.AlpacaStreaming` at module load,
// so the mock MUST nest the throwing class under `coreFFI`. Alpaca also imports getMode/getTempDir.
vi.mock("@ckirg/corelib", () => ({
	coreFFI: {
		AlpacaStreaming: class {
			constructor() {
				throw new Error("failed to open redb: DatabaseAlreadyOpen");
			}
		},
	},
	getMode: () => "production",
	getTempDir: () => "/tmp/test",
	nextCid: () => 1,
	logger: {
		child: () => ({
			trace() {},
			debug() {},
			info() {},
			warn() {},
			error() {},
			fatal() {},
		}),
	},
}));

// import the FACADE after the mock
import { AlpacaStreaming } from "./AlpacaStreaming";

describe("AlpacaStreaming construction error", () => {
	it("propagates a catchable error (does not abort) and preserves the cause", () => {
		expect(() => new AlpacaStreaming()).toThrow(/redb|open/i);
		try {
			new AlpacaStreaming();
		} catch (e) {
			expect((e as Error).message).toMatch(/native init failed/i);
			expect((e as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
		}
	});
});
