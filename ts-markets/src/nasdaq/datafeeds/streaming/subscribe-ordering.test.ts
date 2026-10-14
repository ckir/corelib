// Subscription counts must only change after the native call succeeds.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ckirg/corelib", () => {
	const make = () =>
		class {
			init = vi.fn().mockResolvedValue(undefined);
			start = vi.fn().mockResolvedValue(undefined);
			subscribe = vi.fn().mockResolvedValue(undefined);
			unsubscribe = vi.fn().mockResolvedValue(undefined);
			stop = vi.fn();
			clean = vi.fn();
		};
	const mockLog = {
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		fatal: vi.fn(),
	};
	return {
		getMode: vi.fn(() => "production"),
		getTempDir: vi.fn(() => "/tmp"),
		nextCid: () => 1,
		logger: { ...mockLog, child: () => mockLog },
		coreFFI: {
			AlpacaStreaming: make(),
			YahooStreaming: make(),
			FinnhubStreaming: make(),
		},
	};
});

import { AlpacaStreaming } from "./alpaca/AlpacaStreaming";
import { FinnhubStreaming } from "./finnhub/FinnhubStreaming";
import { YahooStreaming } from "./yahoo/YahooStreaming";

const count = (s: unknown) =>
	(s as { health: { symbolCount: number } }).health.symbolCount;
const rust = (s: unknown) =>
	(s as { rust: Record<string, ReturnType<typeof vi.fn>> }).rust;

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("subscribe ordering: record only after native success", () => {
	beforeEach(() => vi.clearAllMocks());

	it("Finnhub: rejected native subscribe leaves count at 0", async () => {
		const s = new FinnhubStreaming();
		rust(s).subscribe.mockRejectedValueOnce(new Error("boom"));
		await expect(s.subscribe(["AAPL"])).rejects.toThrow("boom");
		expect(count(s)).toBe(0);
		await s.subscribe(["AAPL"]);
		await s.subscribe(["AAPL"]);
		expect(count(s)).toBe(1);
	});

	it("Finnhub: rejected native unsubscribe keeps the count", async () => {
		const s = new FinnhubStreaming();
		await s.subscribe(["AAPL"]);
		rust(s).unsubscribe.mockRejectedValueOnce(new Error("boom"));
		await expect(s.unsubscribe(["AAPL"])).rejects.toThrow("boom");
		expect(count(s)).toBe(1);
	});

	it("Yahoo: sync throw leaves count at 0", () => {
		const s = new YahooStreaming();
		rust(s).subscribe.mockImplementationOnce(() => {
			throw new Error("boom");
		});
		expect(() => s.subscribe(["AAPL"])).toThrow("boom");
		expect(count(s)).toBe(0);
	});

	it("Yahoo: async rejection is not recorded", async () => {
		const s = new YahooStreaming();
		rust(s).subscribe.mockRejectedValueOnce(new Error("boom"));
		s.subscribe(["AAPL"]);
		await flush();
		expect(count(s)).toBe(0);
		s.subscribe(["AAPL"]);
		await flush();
		expect(count(s)).toBe(1);
	});

	it("Yahoo: async rejected unsubscribe keeps the count", async () => {
		const s = new YahooStreaming();
		s.subscribe(["AAPL"]);
		await flush();
		rust(s).unsubscribe.mockRejectedValueOnce(new Error("boom"));
		s.unsubscribe(["AAPL"]);
		await flush();
		expect(count(s)).toBe(1);
	});

	it("Alpaca: async rejection is not recorded; success counts once per symbol", async () => {
		const s = new AlpacaStreaming();
		rust(s).subscribe.mockRejectedValueOnce(new Error("boom"));
		s.subscribe({ quotes: ["AAPL"], trades: ["AAPL", "MSFT"] });
		await flush();
		expect(count(s)).toBe(0);
		s.subscribe({ quotes: ["AAPL"], trades: ["AAPL", "MSFT"] });
		await flush();
		expect(count(s)).toBe(2);
		s.unsubscribe({ quotes: ["AAPL"] });
		await flush();
		expect(count(s)).toBe(2); // AAPL still on trades
	});
});
