import { describe, expect, it, vi } from "vitest";
import { handleDbError } from "./errors";

describe("handleDbError", () => {
	it("should log and return serialized error", () => {
		const mockLogger = {
			error: vi.fn(),
		} as any;

		const error = new Error("Database connection failed");
		const message = "Custom error message";

		const result = handleDbError(mockLogger, message, error);

		expect(mockLogger.error).toHaveBeenCalledWith(message, {
			error: expect.objectContaining({
				message: "Database connection failed",
				name: "Error",
			}),
		});

		expect(result.message).toBe("Database connection failed");
	});
});
