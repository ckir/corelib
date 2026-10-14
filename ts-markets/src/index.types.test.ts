// Compile-time check that the public entry point exports the types a consumer needs.
// `pnpm run typecheck` fails if any of these names is missing from ./index.
import { describe, expectTypeOf, it } from "vitest";
import type {
	AlpacaPricingData,
	FinnhubPricingData,
	HistoricalOptions,
	HistoricalProvider,
	HistoricalResult,
	MarketMonitorOptions,
	NasdaqStatus,
	YahooPricingData,
} from "./index";

describe("index type exports", () => {
	it("exposes consumer-facing types", () => {
		expectTypeOf<HistoricalOptions>().toHaveProperty("period1");
		expectTypeOf<HistoricalProvider>().toHaveProperty("getHistoricalData");
		expectTypeOf<
			HistoricalProvider["getHistoricalData"]
		>().returns.toEqualTypeOf<Promise<HistoricalResult>>();
		expectTypeOf<NasdaqStatus>().toHaveProperty("rCode");
		expectTypeOf<AlpacaPricingData>().toHaveProperty("messageType");
		expectTypeOf<YahooPricingData>().toHaveProperty("dayHigh");
		expectTypeOf<FinnhubPricingData>().toHaveProperty("price");
		expectTypeOf<MarketMonitorOptions>().toHaveProperty("liveIntervalSec");
	});
});
