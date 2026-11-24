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
			return Promise.reject(new Error("async boom")) as unknown as undefined;
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

// ── Mirror-contract semantics ────────────────────────────────────────────────
// Nothing above pinned these, so a croner major bump could have renumbered days
// of week or flipped the DOM+DOW operator and CI would still have been green.
// These are the semantics `rust/src/utils/include_exclude_cron.rs` is pinned to
// (it documents itself as an exact behavioural mirror of cron.ts), so a drift
// here breaks the Rust/TypeScript twin. Expected values are observed croner
// output, measured on both 10.0.1 and 11.0.1.
describe("shouldRunNow mirror-contract semantics (real croner)", () => {
	const run = (include: string[], iso: string) =>
		shouldRunNow(include, [], at(iso), "UTC");
	const runThrows = (include: string[]) => () =>
		shouldRunNow(include, [], at("2026-11-24T12:00:00Z"), "UTC");

	it("numbers days of week POSIX-style, where 0 and 7 are both Sunday", () => {
		// 2026-11-22 Sunday, 11-23 Monday, 11-28 Saturday.
		expect(run(["* * * * * 0 *"], "2026-11-22T12:00:00Z")).toBe(true);
		expect(run(["* * * * * 7 *"], "2026-11-22T12:00:00Z")).toBe(true);
		expect(run(["* * * * * 1 *"], "2026-11-23T12:00:00Z")).toBe(true);
		expect(run(["* * * * * 6 *"], "2026-11-28T12:00:00Z")).toBe(true);
		expect(run(["* * * * * 0 *"], "2026-11-23T12:00:00Z")).toBe(false);
	});

	it("accepts the weekend exclusion `* * * * * 0,6 *`", () => {
		expect(run(["* * * * * 0,6 *"], "2026-11-22T12:00:00Z")).toBe(true);
		expect(run(["* * * * * 0,6 *"], "2026-11-28T12:00:00Z")).toBe(true);
		expect(run(["* * * * * 0,6 *"], "2026-11-24T12:00:00Z")).toBe(false);
	});

	it("reads a 5-field pattern as having seconds 0", () => {
		expect(run(["* * * * *"], "2026-11-24T12:00:00Z")).toBe(true);
		expect(run(["* * * * *"], "2026-11-24T12:00:30Z")).toBe(false);
	});

	it("combines day-of-month and day-of-week with OR (Vixie default)", () => {
		// Fires on the 1st of any month OR on any Monday.
		expect(run(["0 0 0 1 * MON"], "2026-11-02T00:00:00Z")).toBe(true); // Monday, not the 1st
		expect(run(["0 0 0 1 * MON"], "2026-12-01T00:00:00Z")).toBe(true); // the 1st, not Monday
		expect(run(["0 0 0 1 * MON"], "2026-11-24T00:00:00Z")).toBe(false); // neither
	});

	it("flips DOM+DOW to AND when the day-of-week field is prefixed with `+`", () => {
		// 2027-02-01 is a Monday that is also the 1st.
		expect(run(["0 0 0 1 * +MON"], "2027-02-01T00:00:00Z")).toBe(true);
		expect(run(["0 0 0 1 * +MON"], "2026-11-02T00:00:00Z")).toBe(false); // Monday, not the 1st
		expect(run(["0 0 0 1 * +MON"], "2026-12-01T00:00:00Z")).toBe(false); // the 1st, not Monday
	});

	it("rejects full weekday names but accepts 3-letter ones", () => {
		expect(runThrows(["* * * * * SUNDAY *"])).toThrow();
		expect(runThrows(["* * * * * TUES *"])).toThrow();
		expect(run(["* * * * * SUN *"], "2026-11-22T12:00:00Z")).toBe(true);
		expect(run(["* * * * * TUE *"], "2026-11-24T12:00:00Z")).toBe(true);
	});

	it("rejects a single-number step but accepts `*/` and range forms", () => {
		expect(runThrows(["0/10 * * * * * *"])).toThrow();
		expect(run(["*/10 * * * * * *"], "2026-11-24T12:00:00Z")).toBe(true);
		expect(run(["0-59/10 * * * * * *"], "2026-11-24T12:00:00Z")).toBe(true);
	});
});
