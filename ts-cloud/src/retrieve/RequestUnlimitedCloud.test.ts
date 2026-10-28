/**
 * @file ts-cloud/src/retrieve/RequestUnlimitedCloud.test.ts
 * @description Exhaustive test suite for the RequestUnlimited (ky) edge endpoint.
 */

import { endPoint, type RequestResult } from "@ckirg/corelib";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../core/types";
import { kyRouter } from "./RequestUnlimitedCloud";

// Mock the corelib endPoint utility
vi.mock("@ckirg/corelib", () => ({
	endPoint: vi.fn(),
}));

describe("RequestUnlimitedCloud (kyRouter)", () => {
	const mockLogger = {
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
		child: vi.fn().mockReturnThis(),
	};

	/**
	 * Helper to execute a request against the sub-router.
	 */
	const performPost = (body: unknown) => {
		const app = new Hono<AppEnv>();
		app.use("*", async (c, next) => {
			c.set("logger", mockLogger as any);
			await next();
		});
		app.route("/", kyRouter);

		const req = new Request("http://localhost/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

		return app.request(req);
	};

	describe("Single Endpoint Logic", () => {
		it("should return success and mirror the target status code (200)", async () => {
			const mockResult = {
				status: "success",
				value: { status: 200, body: { foo: "bar" } },
			};
			vi.mocked(endPoint).mockResolvedValueOnce(mockResult as any);

			const res = await performPost({ url: "https://example.com" });
			const json = await res.json();

			expect(res.status).toBe(200);
			expect(json).toEqual(mockResult.value.body);
		});

		it("should return error structure if transport fails", async () => {
			const mockResult = {
				status: "error",
				reason: { status: 404, message: "Not Found" },
			};
			vi.mocked(endPoint).mockResolvedValueOnce(mockResult as any);

			const res = await performPost({ url: "https://example.com/missing" });
			const json = await res.json();

			expect(res.status).toBe(404);
			expect(json).toEqual(mockResult);
		});

		it("should map non-contentful status (204) to 200 to allow JSON body", async () => {
			const mockResult = {
				status: "success",
				value: { status: 204, body: null },
			};
			vi.mocked(endPoint).mockResolvedValueOnce(mockResult as any);

			const res = await performPost({ url: "https://example.com/no-content" });
			expect(res.status).toBe(200);
		});

		it("should return text and forward safe headers when target returns text/plain", async () => {
			const mockResult = {
				status: "success",
				value: {
					status: 200,
					headers: {
						"content-type": "text/plain",
						etag: '"abc123etag"',
						"cache-control": "public, max-age=3600",
					},
					body: "hello plain text",
				},
			};
			vi.mocked(endPoint).mockResolvedValueOnce(mockResult as any);

			const res = await performPost({ url: "https://example.com/readme.txt" });
			const text = await res.text();

			expect(res.status).toBe(200);
			expect(text).toBe("hello plain text");
			expect(res.headers.get("etag")).toBe('"abc123etag"');
			expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
		});
	});

	describe("Bulk Endpoints Logic", () => {
		it("should process multiple endpoints and return a 200 status", async () => {
			const mockResults = [
				{ status: "success", value: { status: 200, url: "a" } },
				{ status: "success", value: { status: 404, url: "b" } },
			];
			vi.mocked(endPoint)
				.mockResolvedValueOnce(mockResults[0] as any)
				.mockResolvedValueOnce(mockResults[1] as any);

			const res = await performPost({
				endPoints: [
					{ url: "https://example.com/a" },
					{ url: "https://example.com/b" },
				],
			});

			const json = (await res.json()) as RequestResult<unknown>[];
			expect(res.status).toBe(200);
			expect(Array.isArray(json)).toBe(true);
			expect(json).toHaveLength(2);
		});

		it("should not throw when a bulk entry has a 204 upstream", async () => {
			const noContent = {
				status: "success",
				value: { status: 204, body: null },
			};
			vi.mocked(endPoint).mockResolvedValueOnce(noContent as any);

			const res = await performPost({
				endPoints: [{ url: "https://example.com/no-content" }],
			});

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual([noContent]);
		});
	});

	describe("Bulk payload with malformed entries", () => {
		it("answers 200 with a per-item error for a null entry, keeping its siblings", async () => {
			const res = await performPost({
				endPoints: [null, { url: "http://169.254.169.254/" }],
			});
			expect(res.status).toBe(200);
			const json = (await res.json()) as RequestResult<unknown>[];
			expect(json).toHaveLength(2);
			expect(json.map((r) => r.status)).toEqual(["error", "error"]);
		});
	});

	describe("Validation & Error Handling", () => {
		it("should return 400 if neither 'url' nor 'endPoints' is provided", async () => {
			const res = await performPost({ something: "else" });
			expect(res.status).toBe(400);

			const json = (await res.json()) as any;
			expect(json.reason.message).toContain("Invalid payload");
		});

		it("should return 500 and log error if endPoint utility throws", async () => {
			vi.mocked(endPoint).mockRejectedValueOnce(new Error("Crash"));

			const res = await performPost({ url: "https://example.com" });
			expect(res.status).toBe(500);

			const json = (await res.json()) as any;
			expect(json.reason.message).toBe("Internal Edge Proxy Error");
			expect(mockLogger.error).toHaveBeenCalled();
		});
	});

	describe("Bulk limit", () => {
		const entries = (n: number) =>
			Array.from({ length: n }, (_, i) => ({
				url: `https://example.com/${i}`,
			}));

		it("should reject more than 20 endPoints with 400 before any fetch", async () => {
			vi.mocked(endPoint).mockClear();
			const res = await performPost({ endPoints: entries(21) });
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({
				status: "error",
				reason: { message: "Too many endPoints (max 20)" },
			});
			expect(endPoint).not.toHaveBeenCalled();
		});

		it("should accept exactly 20 endPoints", async () => {
			vi.mocked(endPoint).mockClear();
			vi.mocked(endPoint).mockResolvedValue({
				status: "success",
				value: { status: 200, body: {} },
			} as any);
			const res = await performPost({ endPoints: entries(20) });
			expect(res.status).toBe(200);
			expect(endPoint).toHaveBeenCalledTimes(20);
		});
	});

	describe("Error status mapping", () => {
		it("should map an error reason with status 304 to a valid status", async () => {
			vi.mocked(endPoint).mockResolvedValueOnce({
				status: "error",
				reason: { message: "not modified", status: 304 },
			} as any);
			const res = await performPost({ url: "https://example.com" });
			expect(res.status).toBe(500);
		});

		it("should keep a valid error status from the reason", async () => {
			vi.mocked(endPoint).mockResolvedValueOnce({
				status: "error",
				reason: { message: "nope", status: 404 },
			} as any);
			const res = await performPost({ url: "https://example.com" });
			expect(res.status).toBe(404);
		});
	});
});
