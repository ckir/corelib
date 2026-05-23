import { describe, expect, it } from "vitest";
import { NonRealtime, Realtime } from "./AssetClass";

describe("AssetClass", () => {
	it("should have correct Realtime enum values", () => {
		expect(Realtime.Stocks).toBe("stocks");
		expect(Realtime.Etf).toBe("etf");
		expect(Realtime.Currencies).toBe("currencies");
		expect(Realtime.Crypto).toBe("crypto");
	});

	it("should have correct NonRealtime enum values", () => {
		expect(NonRealtime.MutualFunds).toBe("mutualfunds");
		expect(NonRealtime.Index).toBe("index");
		expect(NonRealtime.FixedIncome).toBe("fixedincome");
	});
});
