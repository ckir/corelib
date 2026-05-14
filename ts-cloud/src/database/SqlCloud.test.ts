import { createDatabase } from "@ckir/corelib";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../core/types";
import { sqlRouter } from "./SqlCloud";

// Mock @ckir/corelib
vi.mock("@ckir/corelib", () => ({
	createDatabase: vi.fn(),
}));

describe("SqlCloud Router", () => {
	const mockLogger = {
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		child: vi.fn().mockReturnThis(),
	};

	const performPost = (body: unknown) => {
		const app = new Hono<AppEnv>();
		app.use("*", async (c, next) => {
			c.set("logger", mockLogger as any);
			(c as any).env = {
				CORELIB_TURSO_URL: "test-url",
				CORELIB_TURSO_TOKEN: "test-token",
			};
			await next();
		});
		app.route("/", sqlRouter);

		const req = new Request("http://localhost/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: body ? JSON.stringify(body) : undefined,
		});

		return app.request(req);
	};

	it("should return 400 if sql query is missing", async () => {
		const res = await performPost({ params: [] });
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.status).toBe("error");
		expect(body.reason.message).toBe("Missing SQL query");
	});

	it("should return 400 if the body is invalid or empty", async () => {
		const res = await performPost(null);
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.status).toBe("error");
		expect(body.reason.message).toBe("Missing request body");
	});

	it("should return success for a valid SQL query", async () => {
		const mockDb = {
			query: vi.fn().mockResolvedValue({
				status: "success",
				value: [{ result: 2 }],
			}),
		};
		vi.mocked(createDatabase).mockResolvedValue(mockDb as any);

		const res = await performPost({ sql: "SELECT 1 + 1", params: [] });
		expect(res.status).toBe(200);

		const body = (await res.json()) as any;
		expect(body.status).toBe("success");
		expect(body.value).toEqual([{ result: 2 }]);

		expect(createDatabase).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "test-url",
				authToken: "test-token",
			}),
		);
	});

	it("should return 500 if database query fails", async () => {
		const mockDb = {
			query: vi.fn().mockRejectedValue(new Error("DB Error")),
		};
		vi.mocked(createDatabase).mockResolvedValue(mockDb as any);

		const res = await performPost({ sql: "SELECT oops" });
		expect(res.status).toBe(500);

		const body = (await res.json()) as any;
		expect(body.status).toBe("error");
		expect(body.reason.message).toBe("Internal SQL Error");
		expect(mockLogger.error).toHaveBeenCalled();
	});
});
