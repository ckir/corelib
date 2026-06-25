import { describe, expect, it } from "vitest";
import { serializeError } from "serialize-error";
import { normalizeExtras } from "./normalize-extras";

describe("normalizeExtras", () => {
	it("returns undefined for undefined", () => {
		expect(normalizeExtras(undefined)).toBeUndefined();
	});

	it("serializes a top-level Error value, preserving the key", () => {
		const out = normalizeExtras({ error: new Error("boom") }) as Record<
			string,
			any
		>;
		expect(out.error).toMatchObject({ name: "Error", message: "boom" });
		expect(typeof out.error.stack).toBe("string");
	});

	it("serializes an Error nested in a plain object", () => {
		const out = normalizeExtras({ a: { b: new Error("deep") } }) as any;
		expect(out.a.b).toMatchObject({ message: "deep" });
	});

	it("serializes an Error nested in an array", () => {
		const out = normalizeExtras({ list: [new Error("inarr")] }) as any;
		expect(out.list[0]).toMatchObject({ message: "inarr" });
	});

	it("wraps extras that is itself an Error under the `err` key", () => {
		const out = normalizeExtras(new Error("whole")) as any;
		expect(out.err).toMatchObject({ name: "Error", message: "whole" });
	});

	it("does not hang on a cyclic structure", () => {
		const o: Record<string, unknown> = { name: "cycle" };
		o.self = o;
		const out = normalizeExtras(o) as any;
		expect(out.name).toBe("cycle");
		expect(out.self).toBe(out); // cycle preserved, not infinite
	});

	it("leaves an already-serialized error object unchanged (idempotent)", () => {
		const pre = { error: serializeError(new Error("pre")) };
		const out = normalizeExtras(pre) as any;
		expect(out.error).toMatchObject({ message: "pre" });
		expect(out.error.name).toBe("Error");
	});

	it("preserves non-error values", () => {
		const date = new Date("2020-01-01T00:00:00Z");
		const out = normalizeExtras({ s: "x", n: 1, b: true, d: date }) as any;
		expect(out.s).toBe("x");
		expect(out.n).toBe(1);
		expect(out.b).toBe(true);
		expect(out.d).toBe(date); // non-plain object passed through by reference
	});

	it("serializes a cross-realm error (tagged [object Error])", () => {
		const fake = { message: "xrealm" };
		Object.defineProperty(fake, Symbol.toStringTag, { value: "Error" });
		const out = normalizeExtras({ e: fake }) as any;
		expect(out.e).toMatchObject({ message: "xrealm" });
	});

	it("does not mutate the caller's object", () => {
		const err = new Error("orig");
		const input = { error: err };
		normalizeExtras(input);
		expect(input.error).toBe(err); // still the original Error instance
	});
});
