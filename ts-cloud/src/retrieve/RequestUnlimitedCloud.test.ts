/**
 * @file ts-cloud/src/retrieve/RequestUnlimitedCloud.test.ts
 * @description Exhaustive test suite for the RequestUnlimited (ky) edge endpoint.
 */

import { endPoint, type RequestResult } from "@ckir/corelib";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../core/types";
import { kyRouter } from "./RequestUnlimitedCloud";

// Mock the corelib endPoint utility
vi.mock("@ckir/corelib", () => ({
	endPoint: vi.fn(),
}));

describe("RequestUnlimitedCloud (kyRouter)", () => {
	const mockLogger = {
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
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
				endPoints: [{ url: "a" }, { url: "b" }],
			});

			const json = (await res.json()) as RequestResult<unknown>[];
			expect(res.status).toBe(200);
			expect(Array.isArray(json)).toBe(true);
			expect(json).toHaveLength(2);
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
});
