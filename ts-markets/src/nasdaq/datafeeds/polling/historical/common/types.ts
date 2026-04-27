// ts-markets/src/nasdaq/datafeeds/polling/historical/common/types.ts

/**
 * Standardized options for fetching historical data.
 */
export interface HistoricalOptions {
	period1: Date | string | number;
	period2?: Date | string | number;
	interval?: "1d" | "1wk" | "1mo";
}

/**
 * Strictly standardized JSON format for historical pricing data.
 * Dates are guaranteed to be ISO-8601 strings.
 */
export interface HistoricalQuote {
	date: string;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
	adjClose: number | null;
}

/**
 * Standard Corelib result pattern.
 */
export type HistoricalResult =
	| { status: "success"; value: HistoricalQuote[] }
	| {
			status: "error";
			reason: { message: string; payload?: unknown; [key: string]: unknown };
	  };

/**
 * Contract for any future historical data provider.
 */
export interface HistoricalProvider {
	getHistoricalData(
		symbol: string,
		options: HistoricalOptions,
	): Promise<HistoricalResult>;
}
