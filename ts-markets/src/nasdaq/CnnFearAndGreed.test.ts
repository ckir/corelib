// =============================================
// FILE: ts-markets/src/nasdaq/CnnFearAndGreed.test.ts
// PURPOSE: Exhaustive test suite for CnnFearAndGreed
// Covers: default single filter, Historical + full, array filter, enum filter,
// transport error, schema validation (warn level), malformed response.
// Uses exact SampleData.json content + MSW.
// =============================================

import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// Mock must be defined before imports that use it
vi.mock("@ckir/corelib", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ckir/corelib")>();
	return {
		...actual,
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			fatal: vi.fn(),
			trace: vi.fn(),
		},
	};
});

import { logger } from "@ckir/corelib";
import {
	CnnFearAndGreed,
	CnnFearAndGreedFilter,
	type CnnResult,
} from "./CnnFearAndGreed";

// =============================================
// EXACT SampleData.json CONTENT (embedded)
// =============================================
const SAMPLE = {
	fear_and_greed: {
		score: 19.9685352622062,
		rating: "extreme fear",
		timestamp: "2026-03-13T23:59:41+00:00",
		previous_close: 21.2,
		previous_1_week: 25.1473684210526,
		previous_1_month: 37.7739130434783,
		previous_1_year: 15.185714285714287,
	},
	fear_and_greed_historical: {
		timestamp: 1773446381000.0,
		score: 19.9685352622062,
		rating: "extreme fear",
		data: [{ x: 1773446381000.0, y: 19.9685352622062, rating: "extreme fear" }],
	},
	market_momentum_sp500: {
		timestamp: 1773434439000.0,
		score: 5.4,
		rating: "extreme fear",
		data: [{ x: 1773434439000.0, y: 6632.19, rating: "extreme greed" }],
	},
	market_momentum_sp125: {
		timestamp: 1773434439000.0,
		score: 5.4,
		rating: "extreme fear",
		data: [{ x: 1773434439000.0, y: 6804.9356, rating: "extreme greed" }],
	},
	stock_price_strength: {
		timestamp: 1773446381000.0,
		score: 30.2,
		rating: "fear",
		data: [{ x: 1773446381000.0, y: 2.1276646522766, rating: "extreme fear" }],
	},
	stock_price_breadth: {
		timestamp: 1773446381000.0,
		score: 22.2,
		rating: "extreme fear",
		data: [
			{ x: 1773446381000.0, y: 1050.01769925903, rating: "extreme greed" },
		],
	},
	put_call_options: {
		timestamp: 1773432959000.0,
		score: 11.2,
		rating: "extreme fear",
		data: [
			{ x: 1773432959000.0, y: 0.839127734565474, rating: "extreme fear" },
		],
	},
	market_volatility_vix: {
		timestamp: 1773432901000.0,
		score: 30.379746835443,
		rating: "fear",
		data: [{ x: 1773432901000.0, y: 27.19, rating: "fear" }],
	},
	market_volatility_vix_50: {
		timestamp: 1773432901000.0,
		score: 30.379746835443,
		rating: "fear",
		data: [{ x: 1773432901000.0, y: 18.7982, rating: "extreme fear" }],
	},
	junk_bond_demand: {
		timestamp: 1773441000000.0,
		score: 20,
		rating: "extreme fear",
		data: [
			{ x: 1773441000000.0, y: 1.3379991159164901, rating: "extreme fear" },
		],
	},
	safe_haven_demand: {
		timestamp: 1773431999000.0,
		score: 20.4,
		rating: "extreme fear",
		data: [
			{ x: 1773431999000.0, y: -1.17469711520334, rating: "extreme fear" },
		],
	},
};

const server = setupServer(
	// 1. Daily success (fixed date used in all tests)
	http.get(
		"https://production.dataviz.cnn.io/index/fearandgreed/graphdata/2026-03-15",
		() => HttpResponse.json(SAMPLE),
	),

	// 2. Historical success
	http.get(
		"https://production.dataviz.cnn.io/index/fearandgreed/graphdata",
		() => HttpResponse.json(SAMPLE),
	),

	// 3. Transport error
	http.get(
		"https://production.dataviz.cnn.io/index/fearandgreed/graphdata/404",
		() => new HttpResponse(null, { status: 404 }),
	),
);

describe("CnnFearAndGreed (Exhaustive)", () => {
	beforeAll(() => server.listen());
	afterEach(() => {
		server.resetHandlers();
		vi.clearAllMocks();
	});
	afterAll(() => server.close());

	describe("getFearAndGreed()", () => {
		it("default single filter (fear_and_greed) returns sub-object", async () => {
			const res: CnnResult =
				await CnnFearAndGreed.getFearAndGreed("2026-03-15");

			expect(res.status).toBe("success");
			if (res.status === "success") {
				expect((res.value as any).score).toBe(19.9685352622062);
				expect((res.value as any).rating).toBe("extreme fear");
			}
			expect(logger?.debug).toHaveBeenCalledWith(
				expect.stringContaining("[CNN] CNN FearAndGreed fetched successfully"),
				expect.any(Object),
			);
		});

		it("Historical + full returns entire object", async () => {
			const res: CnnResult = await CnnFearAndGreed.getFearAndGreed(
				"Historical",
				"full",
			);

			expect(res.status).toBe("success");
			if (res.status === "success") {
				expect((res.value as any).fear_and_greed).toBeDefined();
				expect((res.value as any).market_volatility_vix).toBeDefined();
			}
		});

		it("array filter returns only requested keys", async () => {
			const res: CnnResult = await CnnFearAndGreed.getFearAndGreed(
				"2026-03-15",
				[
					CnnFearAndGreedFilter.MarketVolatilityVix,
					CnnFearAndGreedFilter.StockPriceStrength,
				],
			);

			expect(res.status).toBe("success");
			if (res.status === "success") {
				expect(Object.keys(res.value as object)).toEqual([
					"market_volatility_vix",
					"stock_price_strength",
				]);
				expect((res.value as any).market_volatility_vix.score).toBe(
					30.379746835443,
				);
			}
		});

		it("enum filter works the same as string", async () => {
			const res: CnnResult = await CnnFearAndGreed.getFearAndGreed(
				"2026-03-15",
				CnnFearAndGreedFilter.SafeHavenDemand,
			);

			expect(res.status).toBe("success");
			if (res.status === "success") {
				expect((res.value as any).score).toBe(20.4);
			}
		});

		it("transport error returns error result", async () => {
			const res: CnnResult = await CnnFearAndGreed.getFearAndGreed("404");

			expect(res.status).toBe("error");
			if (res.status === "error") {
				expect(res.reason.message).toBe("Transport Error");
			}
			expect(logger?.error).toHaveBeenCalled();
		});

		it("schema validation failure logs warn and returns error", async () => {
			server.use(
				http.get("*", () =>
					HttpResponse.json({
						fear_and_greed: { score: 10 }, // missing other required keys when filter=full
					}),
				),
			);

			const res: CnnResult = await CnnFearAndGreed.getFearAndGreed(
				"2026-03-15",
				"full",
			);

			expect(res.status).toBe("error");
			if (res.status === "error") {
				expect(res.reason.message).toContain("STRICT SCHEMA VALIDATION FAILED");
			}
			expect(logger?.warn).toHaveBeenCalledWith(
				expect.stringContaining("Schema validation failed"),
				expect.any(Object),
			);
		});

		it("malformed response (not an object) returns error", async () => {
			server.use(http.get("*", () => HttpResponse.json("not-an-object")));

			const res: CnnResult =
				await CnnFearAndGreed.getFearAndGreed("2026-03-15");

			expect(res.status).toBe("error");
			if (res.status === "error") {
				expect(res.reason.message).toBe("Malformed CNN Response");
			}
			expect(logger?.error).toHaveBeenCalled();
		});
	});
});
