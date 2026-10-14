import { describe, expect, it, vi } from "vitest";
import { StreamHealthTracker } from "./StreamHealthTracker";

const log = { trace: vi.fn() } as never;

describe("StreamHealthTracker subscription accounting", () => {
	it("is idempotent: subscribing the same symbol twice counts once", () => {
		const t = new StreamHealthTracker("t", log);
		t.recordSubscribe(["AAPL"]);
		t.recordSubscribe(["AAPL"]);
		expect(t.symbolCount).toBe(1);
		// native unsubscribe removes the key outright, so one unsubscribe drops it
		t.recordUnsubscribe(["AAPL"]);
		expect(t.symbolCount).toBe(0);
	});

	it("keeps a symbol alive while another channel still holds it", () => {
		const t = new StreamHealthTracker("t", log);
		t.recordSubscribe(["AAPL"], "quotes");
		t.recordSubscribe(["AAPL"], "trades");
		t.recordSubscribe(["AAPL"], "trades");
		expect(t.symbolCount).toBe(1);
		t.recordUnsubscribe(["AAPL"], "quotes");
		expect(t.symbolCount).toBe(1);
		t.recordUnsubscribe(["AAPL"], "trades");
		expect(t.symbolCount).toBe(0);
	});

	it("unsubscribing an unknown symbol is a no-op", () => {
		const t = new StreamHealthTracker("t", log);
		t.recordUnsubscribe(["ZZZ"]);
		expect(t.symbolCount).toBe(0);
	});
});
