/**
 * Nasdaq AssetClass values that support REAL-TIME data
 * (live lastSalePrice, netChange, bid/ask, isRealTime: true)
 * Used in the unofficial Nasdaq API (e.g. https://api.nasdaq.com/api/quote/{symbol}/info?assetclass=...)
 */
export enum Realtime {
	Stocks = "stocks",
	Etf = "etf",
	Currencies = "currencies",
	Crypto = "crypto",
}

/**
 * Nasdaq AssetClass values that do NOT support real-time data
 * (only EOD/reference values, isRealTime: false)
 * Used in the unofficial Nasdaq API (e.g. https://api.nasdaq.com/api/quote/{symbol}/info?assetclass=...)
 */
export enum NonRealtime {
	MutualFunds = "mutualfunds",
	Index = "index",
	FixedIncome = "fixedincome", // ← newly confirmed (e.g. CMTN1M, CMTN2Y, etc.)
}
