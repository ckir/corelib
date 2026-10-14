import { describe, expect, it } from "vitest";
import { shouldRunNow } from "./cron";

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
