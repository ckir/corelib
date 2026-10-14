import { afterEach, describe, expect, it, vi } from "vitest";
import { includeExcludeCron, shouldRunNow } from "./cron";

// REAL croner (no mock): the mocked suite in cron.test.ts cannot show what croner actually returns.
const at = (iso: string) => new Date(iso);

describe("shouldRunNow (real croner)", () => {
	it("is true when an include expression matches the instant", () => {
		expect(
			shouldRunNow(["30 * * * * *"], [], at("2026-01-01T10:00:30Z"), "UTC"),
		).toBe(true);
	});

	it("is false when no include expression matches the instant", () => {
		expect(
			shouldRunNow(["0 * * * * *"], [], at("2026-01-01T10:00:30Z"), "UTC"),
		).toBe(false);
	});

	it("is false when an exclude expression also matches", () => {
		expect(
			shouldRunNow(
				["* * * * * *"],
				["30 * * * * *"],
				at("2026-01-01T10:00:30Z"),
				"UTC",
			),
		).toBe(false);
		expect(
			shouldRunNow(
				["* * * * * *"],
				["31 * * * * *"],
				at("2026-01-01T10:00:30Z"),
				"UTC",
			),
		).toBe(true);
	});

	it("evaluates wall-clock time in the given timezone", () => {
		const expr = ["0 0 9 * * *"]; // 09:00:00 daily
		// 14:00Z is 09:00 in New York (EST, January); 09:00Z is not.
		expect(
			shouldRunNow(expr, [], at("2026-01-01T14:00:00Z"), "America/New_York"),
		).toBe(true);
		expect(
			shouldRunNow(expr, [], at("2026-01-01T09:00:00Z"), "America/New_York"),
		).toBe(false);
	});
});

describe("includeExcludeCron (real croner)", () => {
	afterEach(() => vi.useRealTimers());

	it("throws synchronously on an invalid expression instead of inside the timer", () => {
		expect(() => includeExcludeCron(["not a cron"], [], () => {})).toThrow();
		expect(() =>
			includeExcludeCron(["* * * * * *"], ["nope"], () => {}),
		).toThrow();
	});

	it("fires the handler on matching ticks", async () => {
		vi.useFakeTimers({ now: new Date("2026-01-01T10:00:00.100Z") });
		const handler = vi.fn();
		const job = includeExcludeCron(["* * * * * *"], [], handler, "UTC");
		await vi.advanceTimersByTimeAsync(3000);
		job.stop();
		expect(handler.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it("reports a throwing or rejecting handler to onError and keeps ticking", async () => {
		vi.useFakeTimers({ now: new Date("2026-01-01T10:00:00.100Z") });
		const onError = vi.fn();
		let calls = 0;
		const handler = vi.fn(() => {
			calls++;
			if (calls === 1) throw new Error("sync boom");
			return Promise.reject(new Error("async boom")) as unknown as void;
		});
		const job = includeExcludeCron(
			["* * * * * *"],
			[],
			handler,
			"UTC",
			onError,
		);
		await vi.advanceTimersByTimeAsync(3000);
		job.stop();
		expect(handler.mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(onError.mock.calls.map((c) => (c[0] as Error).message)).toEqual(
			expect.arrayContaining(["sync boom", "async boom"]),
		);
	});
});
