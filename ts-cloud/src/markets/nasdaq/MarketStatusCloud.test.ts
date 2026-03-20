/**
 * @file ts-cloud/src/markets/nasdaq/MarketStatusCloud.test.ts
 * @description Exhaustive test suite for the MarketStatusCloud Hono router.
 * Covers: Success responses, API-level errors, and internal crash resilience with logging.
 */

import {
	MarketStatus,
	type NasdaqMarketInfo,
	type NasdaqResult,
} from "@ckir/corelib-markets";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../core/types";
import { marketStatusRouter } from "./MarketStatusCloud";

// Mock the corelib-markets dependency
vi.mock("@ckir/corelib-markets", () => ({
	MarketStatus: {
		getStatus: vi.fn(),
	},
}));

describe("MarketStatusCloud (Edge)", () => {
	/**
	 * Scenario 1: Success
	 * Correctly typed mockSuccess to NasdaqResult<NasdaqMarketInfo> to satisfy corelib-markets types.
	 */
	it("should return 200 OK and the success result when getStatus succeeds", async () => {
		const mockSuccess: NasdaqResult<NasdaqMarketInfo> = {
			status: "success",
			value: {
				mrktStatus: "Open",
				nextTradeDate: "2026-03-20",
				pmOpenRaw: "2026-03-20T04:00:00",
				openRaw: "2026-03-20T09:30:00",
			} as NasdaqMarketInfo,
		};
		vi.mocked(MarketStatus.getStatus).mockResolvedValueOnce(mockSuccess);

		const res = await marketStatusRouter.request("/");

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual(mockSuccess);
	});

	/**
	 * Scenario 2: API Logic Error
	 * Ensures the proxy correctly passes through error objects returned by the underlying API.
	 */
	it("should return 200 OK and the error result when getStatus returns a logical error", async () => {
		const mockError = {
			status: "error",
			reason: { message: "Nasdaq API Down" },
		} as NasdaqResult<NasdaqMarketInfo>;

		vi.mocked(MarketStatus.getStatus).mockResolvedValueOnce(mockError);

		const res = await marketStatusRouter.request("/");

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual(mockError);
	});

	/**
	 * Scenario 3: Internal Crash & Logging
	 * Verifies that the catch block triggers correctly and utilizes serializeError for logging.
	 */
	it("should catch exceptions, log serialized error, and return fatal proxy error", async () => {
		const testError = new Error("Mocked Database Crash");
		vi.mocked(MarketStatus.getStatus).mockRejectedValueOnce(testError);

		const app = new Hono<AppEnv>();
		const mockLogger = { error: vi.fn() };

		app.use("*", async (c, next) => {
			// Rule 'noExplicitAny' is off in biome.json; no suppression comment needed.
			c.set("logger", mockLogger as any);
			await next();
		});

		app.route("/", marketStatusRouter);

		const res = await app.request("/");

		expect(res.status).toBe(200);
		const body = (await res.json()) as NasdaqResult;

		// Verify response structure
		expect(body.status).toBe("error");
		if (body.status === "error") {
			expect(body.reason?.message).toBe("Internal Edge Proxy Error");
		}

		// Verify logging (serialize-error usage)
		expect(mockLogger.error).toHaveBeenCalledWith(
			"MarketStatusCloud: Internal execution error",
			expect.objectContaining({
				error: expect.objectContaining({
					message: "Mocked Database Crash",
					name: "Error",
				}),
			}),
		);
	});
});
