import { describe, expect, it } from "vitest";
import { createMockLogger } from "./logger-mock";

describe("createMockLogger", () => {
	it("exposes all six levels as callable mocks", () => {
		const l = createMockLogger();
		for (const m of [
			"trace",
			"debug",
			"info",
			"warn",
			"error",
			"fatal",
		] as const) {
			expect(typeof l[m]).toBe("function");
			l[m]("msg", { a: 1 });
			expect(l[m]).toHaveBeenCalledWith("msg", { a: 1 });
		}
	});
	it("child() returns a logger with the same level methods (self)", () => {
		const l = createMockLogger();
		const c = l.child({ section: "X" });
		expect(c).toBe(l);
		c.trace("t");
		expect(l.trace).toHaveBeenCalledWith("t");
	});
});
