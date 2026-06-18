import { describe, expect, it } from "vitest";
import { defaultRedactor, redactParams } from "./redact";

describe("defaultRedactor", () => {
	it("passes through non-secret scalars (forensic value, not secrets)", () => {
		expect(defaultRedactor(42)).toBe(42);
		expect(defaultRedactor(true)).toBe(true);
		expect(defaultRedactor(false)).toBe(false);
		expect(defaultRedactor(null)).toBeNull();
		expect(defaultRedactor(undefined)).toBeUndefined();
		expect(defaultRedactor(123n)).toBe(123n);
		expect(defaultRedactor("AAPL")).toBe("AAPL");
		expect(defaultRedactor("acc1")).toBe("acc1");
	});

	it("masks secret-shaped strings (JWT / long hex / long base64)", () => {
		expect(defaultRedactor("eyJhbGc.eyJzdWIi.sIgNaTuRe")).toMatch(
			/^<redacted:len=\d+>$/,
		);
		// 32-char hex
		expect(defaultRedactor("0123456789abcdef0123456789abcdef")).toMatch(
			/^<redacted:len=/,
		);
		// 40-char base64/token-ish
		expect(defaultRedactor("A".repeat(40))).toMatch(/^<redacted:len=/);
	});

	it("truncates very long non-secret strings", () => {
		const long = `note ${"word ".repeat(100)}`; // has spaces -> not b64; > 256 chars
		const out = defaultRedactor(long) as string;
		expect(out).toMatch(/…\(len=\d+\)$/);
		expect(out.length).toBeLessThan(long.length);
	});

	it("never deep-logs objects or arrays", () => {
		expect(defaultRedactor({ a: 1 })).toBe("<redacted:object>");
		expect(defaultRedactor([1, 2, 3])).toBe("<redacted:object>");
	});
});

describe("redactParams", () => {
	it("returns undefined when there are no params", () => {
		expect(redactParams(undefined, defaultRedactor)).toBeUndefined();
	});

	it("redacts positional params and caps the array", () => {
		expect(
			redactParams([1, "AAPL", "eyJa.eyJb.sIg"], defaultRedactor),
		).toEqual([1, "AAPL", expect.stringMatching(/^<redacted/)]);

		const many = Array.from({ length: 70 }, (_, i) => i);
		const out = redactParams(many, defaultRedactor) as unknown[];
		expect(out).toHaveLength(65); // 64 capped values + 1 overflow marker
		expect(out[64]).toMatch(/\+6 more/);
	});

	it("key-denylists sensitive NAMED params regardless of value shape", () => {
		const out = redactParams(
			{ id: 7, password: "hunter2", apiKey: "short", symbol: "AAPL" },
			defaultRedactor,
		) as Record<string, unknown>;
		expect(out.id).toBe(7);
		expect(out.symbol).toBe("AAPL");
		expect(out.password).toBe("<redacted:key>"); // would otherwise pass through
		expect(out.apiKey).toBe("<redacted:key>");
	});
});
