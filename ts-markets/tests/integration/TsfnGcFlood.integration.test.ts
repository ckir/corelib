import { coreFFI } from "@ckirg/corelib";
import { afterAll, describe, expect, it } from "vitest";

describe("TSFN inbound delivery under GC stress", () => {
	// Don't let the diagnostic gate leak into other integration tests sharing this fork
	// (ConfigManager scans CORELIB_-prefixed env vars on initialize).
	afterAll(() => {
		delete process.env.CORELIB_DIAG_FLOOD;
	});

	it("delivers every flooded event with no deadlock under global.gc()", async () => {
		if (!globalThis.gc) {
			console.warn("skip: run with --expose-gc");
			return;
		}
		const flood = (coreFFI as any)?.napiTriggerDiagnosticFlood;
		expect(typeof flood).toBe("function");
		process.env.CORELIB_DIAG_FLOOD = "1";
		const COUNT = 5000;
		let delivered = 0;
		await new Promise<void>((resolve, reject) => {
			const gcLoop = setInterval(() => globalThis.gc?.(), 1);
			const t = setTimeout(() => {
				clearInterval(gcLoop);
				reject(new Error("deadlock: flood did not complete"));
			}, 15000);
			flood(COUNT, (_err: unknown, _ev: unknown) => {
				if (++delivered >= COUNT) {
					clearInterval(gcLoop);
					clearTimeout(t);
					resolve();
				}
			});
		});
		expect(delivered).toBe(COUNT);
	});
});
