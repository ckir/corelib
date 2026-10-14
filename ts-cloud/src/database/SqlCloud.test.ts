import { createDatabase } from "@ckirg/corelib";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../core/types";
import { sqlRouter } from "./SqlCloud";

// Mock @ckirg/corelib
vi.mock("@ckirg/corelib", () => ({
	createDatabase: vi.fn(),
}));

describe("SqlCloud Router", () => {
	const mockLogger = {
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
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
		expect(mockLogger.debug).toHaveBeenCalledWith(
			"sql: rejected",
			expect.objectContaining({ reason: expect.any(String) }),
		);
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
			disconnect: vi.fn().mockResolvedValue(undefined),
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
				// flight-recorder: rid→traceId hook is wired onto every query.
				getTraceId: expect.any(Function),
			}),
		);
		expect(mockLogger.debug).toHaveBeenCalledWith(
			"sql: request",
			expect.objectContaining({ hasSql: true }),
		);
		expect(mockLogger.debug).toHaveBeenCalledWith(
			"sql: ok",
			expect.objectContaining({ status: expect.any(String) }),
		);
		// REDACTION: sql text / params values must never be logged
		expect(mockLogger.debug).not.toHaveBeenCalledWith(
			"sql: request",
			expect.objectContaining({ sql: expect.anything() }),
		);
	});

	it("should return 500 if database query fails", async () => {
		const mockDb = {
			query: vi.fn().mockRejectedValue(new Error("DB Error")),
			disconnect: vi.fn().mockResolvedValue(undefined),
		};
		vi.mocked(createDatabase).mockResolvedValue(mockDb as any);

		const res = await performPost({ sql: "SELECT oops" });
		expect(res.status).toBe(500);

		const body = (await res.json()) as any;
		expect(body.status).toBe("error");
		expect(body.reason.message).toBe("Internal SQL Error");
		expect(mockLogger.error).toHaveBeenCalled();
	});

	it.each([
		["number sql", { sql: 5 }],
		["object sql", { sql: { a: 1 } }],
		["blank sql", { sql: "   " }],
	])(
		"should return 400 for %s and not create a database",
		async (_n, payload) => {
			vi.mocked(createDatabase).mockClear();
			const res = await performPost(payload);
			expect(res.status).toBe(400);
			expect(createDatabase).not.toHaveBeenCalled();
		},
	);

	it.each([
		["string params", "x"],
		["number params", 3],
	])(
		"should return 400 for %s and not create a database",
		async (_n, params) => {
			vi.mocked(createDatabase).mockClear();
			const res = await performPost({ sql: "SELECT 1", params });
			expect(res.status).toBe(400);
			const body = (await res.json()) as any;
			expect(body.reason.message).toContain("Invalid params");
			expect(createDatabase).not.toHaveBeenCalled();
		},
	);

	it("should accept array and plain-object params", async () => {
		const mockDb = {
			query: vi.fn().mockResolvedValue({ status: "success", value: [] }),
			disconnect: vi.fn().mockResolvedValue(undefined),
		};
		vi.mocked(createDatabase).mockResolvedValue(mockDb as any);
		expect((await performPost({ sql: "S", params: [1] })).status).toBe(200);
		expect((await performPost({ sql: "S", params: { a: 1 } })).status).toBe(
			200,
		);
		expect((await performPost({ sql: "S" })).status).toBe(200);
	});

	it("should disconnect after a successful query", async () => {
		const mockDb = {
			query: vi.fn().mockResolvedValue({ status: "success", value: [] }),
			disconnect: vi.fn().mockResolvedValue(undefined),
		};
		vi.mocked(createDatabase).mockResolvedValue(mockDb as any);
		await performPost({ sql: "SELECT 1" });
		expect(mockDb.disconnect).toHaveBeenCalledTimes(1);
	});

	it("should disconnect after a failed query", async () => {
		const mockDb = {
			query: vi.fn().mockRejectedValue(new Error("boom")),
			disconnect: vi.fn().mockResolvedValue(undefined),
		};
		vi.mocked(createDatabase).mockResolvedValue(mockDb as any);
		const res = await performPost({ sql: "SELECT 1" });
		expect(res.status).toBe(500);
		expect(mockDb.disconnect).toHaveBeenCalledTimes(1);
	});

	it("should not mask the result when disconnect itself fails", async () => {
		const mockDb = {
			query: vi.fn().mockResolvedValue({ status: "success", value: [] }),
			disconnect: vi.fn().mockRejectedValue(new Error("close failed")),
		};
		vi.mocked(createDatabase).mockResolvedValue(mockDb as any);
		const res = await performPost({ sql: "SELECT 1" });
		expect(res.status).toBe(200);
	});
});
