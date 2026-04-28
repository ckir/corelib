// ts-markets/src/nasdaq/datafeeds/polling/historical/providers/YahooHistoricalProvider.ts

import { logger } from "@ckir/corelib";
import { DateTime } from "luxon";
import { serializeError } from "serialize-error";
import type {
	HistoricalOptions,
	HistoricalProvider,
	HistoricalQuote,
	HistoricalResult,
} from "../common/types";

export class YahooHistoricalProvider implements HistoricalProvider {
	constructor(private yf: any) {}

	public async getHistoricalData(
		symbol: string,
		options: HistoricalOptions,
	): Promise<HistoricalResult> {
		try {
			// Map Corelib options to Yahoo's specific query options
			// Workaround for yahoo-finance2 v3 bug where undefined period2 fails validation
			const queryOptions: Record<string, unknown> = {
				period1: options.period1,
				period2: options.period2 || new Date(),
			};
			if (options.interval) queryOptions.interval = options.interval;

			// This underlying call now routes automatically through the custom fetch in the yf instance
			const data = await this.yf.historical(symbol, queryOptions as any);

			// Transform to strictly standardized JSON format
			const value: HistoricalQuote[] = data.map((item: any) => ({
				symbol,
				date:
					DateTime.fromJSDate(item.date).toUTC().toISO() ||
					item.date.toISOString(),
				open: item.open,
				high: item.high,
				low: item.low,
				close: item.close,
				volume: item.volume,
				adjClose: item.adjClose ?? null,
			}));

			return { status: "success", value };
		} catch (error: unknown) {
			const serialized = serializeError(error);
			logger?.error(`[Historical] Yahoo provider failed for ${symbol}`, {
				error: serialized,
			});

			return {
				status: "error",
				reason: {
					message: serialized.message || "Failed to fetch historical data",
					payload: serialized,
				},
			};
		}
	}
}
