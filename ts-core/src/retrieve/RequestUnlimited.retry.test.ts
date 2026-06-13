import { describe, expect, it } from "vitest";
import {
	clampNumber,
	fullJitterDelay,
	MAX_BACKOFF_LIMIT_MS,
	MAX_RETRY_LIMIT,
} from "./RequestUnlimited";

describe("clampNumber", () => {
	it("falls back on non-finite / non-number / negative", () => {
		expect(clampNumber(Number.NaN, 0, 10, 5)).toBe(5);
		expect(clampNumber(Number.POSITIVE_INFINITY, 0, 10, 5)).toBe(5);
		expect(clampNumber(-3, 0, 10, 5)).toBe(0); // clamped to min
		expect(clampNumber("9" as unknown as number, 0, 10, 5)).toBe(5); // non-number → fallback
	});
	it("clamps to the ceiling and passes through valid values", () => {
		expect(clampNumber(999, 0, MAX_RETRY_LIMIT, 5)).toBe(MAX_RETRY_LIMIT);
		expect(clampNumber(7, 0, MAX_RETRY_LIMIT, 5)).toBe(7);
	});
	it("passes the in-range boundary value through (does not fall back)", () => {
		expect(clampNumber(0, 0, 10, 5)).toBe(0); // valid min, NOT the fallback
		expect(clampNumber(10, 0, 10, 5)).toBe(10); // valid max
	});
});

describe("fullJitterDelay", () => {
	it("stays within [0, min(backoffLimit, base)] and never exceeds the ceiling", () => {
		for (let attempt = 1; attempt <= 8; attempt++) {
			for (let i = 0; i < 50; i++) {
				const d = fullJitterDelay(attempt, MAX_BACKOFF_LIMIT_MS);
				const base = Math.min(MAX_BACKOFF_LIMIT_MS, 300 * 2 ** (attempt - 1));
				expect(d).toBeGreaterThanOrEqual(0);
				expect(d).toBeLessThanOrEqual(base);
				expect(d).toBeLessThanOrEqual(MAX_BACKOFF_LIMIT_MS);
			}
		}
	});
	it("caps at backoffLimit when it binds below the natural exponential", () => {
		// attempt 5 → natural base 300*2^4 = 4800ms, but backoffLimit 3000 binds.
		for (let i = 0; i < 100; i++) {
			const d = fullJitterDelay(5, 3000);
			expect(d).toBeGreaterThanOrEqual(0);
			expect(d).toBeLessThanOrEqual(3000);
		}
	});
});
