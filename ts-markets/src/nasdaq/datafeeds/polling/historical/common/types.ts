// ts-markets/src/nasdaq/datafeeds/polling/historical/common/types.ts

/**
 * Standardized options for fetching historical data.
 */
export interface HistoricalOptions {
	/** Start date of the historical data range. Can be a Date object, ISO string, or Unix timestamp. */
	period1: Date | string | number;
	/** End date of the historical data range (inclusive). Defaults to current time if omitted. */
	period2?: Date | string | number;
	/** The resolution of the data points. */
	interval?: "1d" | "1wk" | "1mo";
}

/**
 * Strictly standardized JSON format for historical pricing data.
 * Dates are guaranteed to be ISO-8601 strings.
 */
export interface HistoricalQuote {
	/** Trading symbol. */
	symbol: string;
	/** ISO-8601 date string for the quote. */
	date: string;
	/** Opening price. */
	open: number;
	/** Highest price during the period. */
	high: number;
	/** Lowest price during the period. */
	low: number;
	/** Closing price. */
	close: number;
	/** Trading volume. */
	volume: number;
	/** Adjusted closing price (accounting for dividends and splits). */
	adjClose: number | null;
}

/**
 * Standard Corelib result pattern for historical data.
 */
export type HistoricalResult =
	| {
			/** Indicates a successful data retrieval. */
			status: "success";
			/** Array of historical quotes. */
			value: HistoricalQuote[];
	  }
	| {
			/** Indicates a failure in data retrieval. */
			status: "error";
			/** The reason for the failure. */
			reason: {
				/** Error message. */
				message: string;
				/** Optional error payload for debugging. */
				payload?: unknown;
				[key: string]: unknown;
			};
	  };

/**
 * Contract for any future historical data provider.
 * Implementations should adapt external API responses to the standardized HistoricalResult format.
 */
export interface HistoricalProvider {
	/**
	 * Fetches historical pricing data for a given symbol and options.
	 *
	 * @param {string} symbol - The trading symbol.
	 * @param {HistoricalOptions} options - The date range and interval options.
	 * @returns {Promise<HistoricalResult>} A promise resolving to the historical data result.
	 */
	getHistoricalData(
		symbol: string,
		options: HistoricalOptions,
	): Promise<HistoricalResult>;
}
