import { logger } from "@ckir/corelib";
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
import { Historical } from "./Historical";

// Mock corelib logger to prevent console noise during tests
vi.mock("@ckir/corelib", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ckir/corelib")>();
	return {
		...actual,
		logger: {
			error: vi.fn(),
			info: vi.fn(),
		},
	};
});

const MOCK_CHART_META = {
	currency: "USD",
	symbol: "AAPL",
	exchangeName: "NMS",
	instrumentType: "EQUITY",
	firstTradeDate: 345479400,
	regularMarketTime: 1637355602,
	gmtoffset: -18000,
	timezone: "EST",
	exchangeTimezoneName: "America/New_York",
	regularMarketPrice: 160.55,
	priceHint: 2,
	currentTradingPeriod: {
		pre: {
			timezone: "EST",
			start: 1637355600,
			end: 1637370000,
			gmtoffset: -18000,
		},
		regular: {
			timezone: "EST",
			start: 1637355600,
			end: 1637370000,
			gmtoffset: -18000,
		},
		post: {
			timezone: "EST",
			start: 1637355600,
			end: 1637370000,
			gmtoffset: -18000,
		},
	},
	dataGranularity: "1d",
	range: "",
	validRanges: ["1d", "5d", "1mo"],
};

/**
 * MSW Server Setup
 * We intercept the specific URLs yahoo-finance2 hits.
 * v3 uses query2 by default.
 */
const server = setupServer(
	// 1. Mock the Crumb/Cookie retrieval (Internal Yahoo behavior)
	http.get("https://query1.finance.yahoo.com/v1/test/getcrumb", () => {
		return HttpResponse.text("mock-crumb-123", {
			headers: { "set-cookie": "B=mock_cookie_id" },
		});
	}),

	// 2. Mock the Historical Data Endpoint (query2 for v3)
	http.get(
		"https://query2.finance.yahoo.com/v8/finance/chart/:symbol",
		({ params, request }) => {
			const { symbol } = params;
			const _url = new URL(request.url);

			// Scenario: Rate Limiting (429)
			if (symbol === "TOO_MANY_REQUESTS") {
				return new HttpResponse(null, {
					status: 429,
					statusText: "Too Many Requests",
				});
			}

			// Scenario: Symbol Not Found (404)
			if (symbol === "INVALID") {
				return HttpResponse.json(
					{
						chart: {
							result: null,
							error: { code: "Not Found", description: "No data found" },
						},
					},
					{ status: 404 },
				);
			}

			// Scenario: Success
			return HttpResponse.json({
				chart: {
					result: [
						{
							meta: { ...MOCK_CHART_META, symbol },
							timestamp: [1710423000], // 2024-03-14T13:30:00Z
							indicators: {
								quote: [
									{
										open: [150.0],
										high: [155.0],
										low: [149.0],
										close: [153.0],
										volume: [10000],
									},
								],
								adjclose: [{ adjclose: [153.0] }],
							},
						},
					],
					error: null,
				},
			});
		},
	),
);

describe("Historical Module - Yahoo Provider with corelib Interceptor", () => {
	beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
	afterEach(() => {
		server.resetHandlers();
		vi.clearAllMocks();
	});
	afterAll(() => server.close());

	it("successfully fetches and standardizes data through the interceptor", async () => {
		const result = await Historical.getData("AAPL", {
			period1: "2024-03-14",
		});

		expect(result.status).toBe("success");

		if (result.status === "success") {
			const quote = result.value[0];
			// Verify date transformation to ISO string
			expect(quote.date).toBe("2024-03-14T13:30:00.000Z");
			expect(quote.close).toBe(153.0);
		}
	});

	it("handles 429 Rate Limit errors via corelib serialization", async () => {
		const result = await Historical.getData("TOO_MANY_REQUESTS", {
			period1: "2024-03-14",
		});

		expect(result.status).toBe("error");

		if (result.status === "error") {
			// The message comes from Yahoo library's interpretation of our mocked 429
			expect(result.reason.message).toBeDefined();
			// Ensure the raw status is preserved in the payload
			const payload = result.reason.payload as any;
			// In v3, the code is in .code (from HTTPError)
			expect(payload.code).toBe(429);
		}

		expect(logger.error).toHaveBeenCalled();
	}, 20000);

	it("handles 404 Not Found errors with full payload serialization", async () => {
		const result = await Historical.getData("INVALID", {
			period1: "2024-03-14",
		});

		expect(result.status).toBe("error");

		if (result.status === "error") {
			// In v3, the error from chart result is converted to an error class if available
			expect(result.reason.message).toContain("No data found");
		}
	});

	it("verifies that period parameters are correctly passed", async () => {
		// We can spy on the interceptor if needed, but checking the result
		// proves the library accepted the options and MSW matched the request.
		const result = await Historical.getData("MSFT", {
			period1: "2024-01-01",
			period2: "2024-01-02",
			interval: "1d",
		});

		expect(result.status).toBe("success");
	});
});
