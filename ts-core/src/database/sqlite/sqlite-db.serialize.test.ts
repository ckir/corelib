import { serializeError } from "serialize-error";
import { describe, expect, it } from "vitest";

describe("error log serialization contract", () => {
	it("serializeError preserves message + name that bare JSON.stringify drops", () => {
		const e = new Error("boom");
		expect(JSON.stringify(e)).toBe("{}"); // a bare Error stringifies to "{}" — the bug
		(e as Error & { cause?: unknown }).cause = new Error("root");
		const s = serializeError(e) as Record<string, unknown>;
		expect(s.message).toBe("boom");
		expect(s.name).toBe("Error");
		expect(JSON.stringify(s)).toContain("boom");
	});
});
