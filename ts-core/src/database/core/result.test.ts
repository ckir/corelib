import { describe, expect, it } from "vitest";
import { wrapError, wrapSuccess } from "./result";

describe("DatabaseResult", () => {
	it("should wrap success value", () => {
		const result = wrapSuccess({ foo: "bar" }, { count: 1 });
		expect(result.status).toBe("success");
		if (result.status === "success") {
			expect(result.value).toEqual({ foo: "bar" });
			expect(result.details).toEqual({ count: 1 });
		}
	});

	it("should wrap error value", () => {
		const error = new Error("Test error");
		const result = wrapError(error);
		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.reason.message).toBe("Test error");
			expect(result.reason.name).toBe("Error");
		}
	});

	it("should wrap plain string as error", () => {
		const result = wrapError("Simple error");
		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect((result.reason as any).message).toContain("Simple error");
		}
	});
});
