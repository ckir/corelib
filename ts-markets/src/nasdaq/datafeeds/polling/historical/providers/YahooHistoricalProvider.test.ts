import { beforeEach, describe, expect, it, vi } from "vitest";
import { YahooHistoricalProvider } from "./YahooHistoricalProvider";

// Mock corelib logger
vi.mock("@ckirg/corelib", () => ({
	logger: {
		child: vi.fn().mockReturnThis(),
		error: vi.fn(),
		trace: vi.fn(),
	},
	nextCid: () => 1,
}));

describe("YahooHistoricalProvider", () => {
	let mockYf: any;
	let provider: YahooHistoricalProvider;

	beforeEach(() => {
		vi.clearAllMocks();
		mockYf = {
			historical: vi.fn(),
		};
		provider = new YahooHistoricalProvider(mockYf);
	});

	it("should transform raw yahoo data to standardized format", async () => {
		const rawData = [
			{
				date: new Date("2024-03-14T13:30:00Z"),
				open: 150,
				high: 155,
				low: 149,
				close: 153,
				volume: 10000,
				adjClose: 153,
			},
		];
		mockYf.historical.mockResolvedValue(rawData);

		const result = await provider.getHistoricalData("AAPL", {
			period1: "2024-03-14",
		});

		expect(result.status).toBe("success");
		if (result.status === "success") {
			expect(result.value).toHaveLength(1);
			expect(result.value[0]).toEqual({
				symbol: "AAPL",
				date: "2024-03-14T13:30:00.000Z",
				open: 150,
				high: 155,
				low: 149,
				close: 153,
				volume: 10000,
				adjClose: 153,
			});
		}
	});

	it("should handle missing adjClose", async () => {
		const rawData = [
			{
				date: new Date("2024-03-14T13:30:00Z"),
				open: 150,
				high: 155,
				low: 149,
				close: 153,
				volume: 10000,
			},
		];
		mockYf.historical.mockResolvedValue(rawData);

		const result = await provider.getHistoricalData("AAPL", {
			period1: "2024-03-14",
		});

		expect(result.status).toBe("success");
		if (result.status === "success") {
			expect(result.value[0].adjClose).toBeNull();
		}
	});

	it("should handle errors from the yahoo-finance library", async () => {
		const error = new Error("Yahoo API Error");
		mockYf.historical.mockRejectedValue(error);

		const result = await provider.getHistoricalData("AAPL", {
			period1: "2024-03-14",
		});

		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.reason.message).toBe("Yahoo API Error");
			expect(result.reason.payload).toBeDefined();
		}
	});

	it("should pass correct parameters to yf.historical", async () => {
		mockYf.historical.mockResolvedValue([]);
		const options = {
			period1: "2024-01-01",
			period2: "2024-01-05",
			interval: "1d" as any,
		};

		await provider.getHistoricalData("MSFT", options);

		expect(mockYf.historical).toHaveBeenCalledWith("MSFT", {
			period1: options.period1,
			period2: options.period2,
			interval: options.interval,
		});
	});
});
