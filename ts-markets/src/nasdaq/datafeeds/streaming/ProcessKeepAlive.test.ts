import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProcessKeepAlive } from "./ProcessKeepAlive.js";

describe("ProcessKeepAlive", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("holds one timer while held and none before or after", () => {
		const k = new ProcessKeepAlive();
		expect(vi.getTimerCount()).toBe(0);
		expect(k.held).toBe(false);
		k.hold();
		expect(vi.getTimerCount()).toBe(1);
		expect(k.held).toBe(true);
		k.release();
		expect(vi.getTimerCount()).toBe(0);
		expect(k.held).toBe(false);
	});

	it("hold is idempotent: a second hold does not add a timer", () => {
		const k = new ProcessKeepAlive();
		k.hold();
		k.hold();
		expect(vi.getTimerCount()).toBe(1);
		k.release();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("release without hold, and a second release, are no-ops", () => {
		const k = new ProcessKeepAlive();
		k.release();
		k.hold();
		k.release();
		k.release();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("can be held again after a release", () => {
		const k = new ProcessKeepAlive();
		k.hold();
		k.release();
		k.hold();
		expect(vi.getTimerCount()).toBe(1);
		k.release();
	});
});
