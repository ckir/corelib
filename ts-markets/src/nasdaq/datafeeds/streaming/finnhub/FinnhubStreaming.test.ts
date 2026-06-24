// =============================================
// FILE: ts-markets/src/nasdaq/datafeeds/streaming/finnhub/FinnhubStreaming.test.ts
// PURPOSE: Unit tests for FinnhubStreaming wrapper
// Covers: constructor, init, start/stop, subscribe/unsubscribe,
// all events including unified "market" event.
// =============================================

import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mocks to ensure they are set up before importing FinnhubStreaming
vi.mock("@ckirg/corelib", () => {
	class MockFinnhub {
		on_log: any;
		on_pricing: any;
		on_event: any;
		on_market: any;
		constructor(on_log: any, on_pricing: any, on_event: any, on_market: any) {
			this.on_log = on_log;
			this.on_pricing = on_pricing;
			this.on_event = on_event;
			this.on_market = on_market;
		}
		init = vi.fn().mockResolvedValue(undefined);
		start = vi.fn().mockResolvedValue(undefined);
		subscribe = vi.fn().mockResolvedValue(undefined);
		unsubscribe = vi.fn().mockResolvedValue(undefined);
		stop = vi.fn().mockResolvedValue(undefined);
		clean = vi.fn().mockResolvedValue(undefined);
	}

	const mockLog = {
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		fatal: vi.fn(),
	};
	return {
		nextCid: () => 1,
		logger: { ...mockLog, child: () => mockLog },
		coreFFI: {
			FinnhubStreaming: MockFinnhub,
		},
	};
});

import { FinnhubStreaming } from "./FinnhubStreaming";

describe("FinnhubStreaming", () => {
	let stream: FinnhubStreaming;
	let mockRust: any;

	beforeEach(() => {
		vi.clearAllMocks();
		stream = new FinnhubStreaming();
		mockRust = (stream as any).rust;
	});

	it("should construct without throwing", () => {
		expect(stream).toBeDefined();
	});

	it("should emit log event", () => {
		const logSpy = vi.fn();
		stream.on("log", logSpy);

		const record = { level: "info", msg: "Test" };
		mockRust.on_log(null, record);

		expect(logSpy).toHaveBeenCalledWith(record);
	});

	it("should emit pricing event", () => {
		const pricingSpy = vi.fn();
		stream.on("pricing", pricingSpy);

		const data = { symbol: "AAPL", price: 150.5 } as any;
		mockRust.on_pricing(null, data);

		expect(pricingSpy).toHaveBeenCalledWith(data);
	});

	it("should emit event.type events from the event callback", () => {
		const connectedSpy = vi.fn();
		stream.on("connected", connectedSpy);

		mockRust.on_event(null, { type: "connected", data: null });

		expect(connectedSpy).toHaveBeenCalledWith(null);
	});

	it("should not emit when event callback receives null", () => {
		const anySpy = vi.fn();
		stream.on("connected", anySpy);

		mockRust.on_event(null, null);

		expect(anySpy).not.toHaveBeenCalled();
	});

	it("emits 'market' when the unified callback fires", () => {
		const marketSpy = vi.fn();
		stream.on("market", marketSpy);

		const payload = { type: "trade", ticker: "AAPL" };
		mockRust.on_market(null, JSON.stringify(payload));

		expect(marketSpy).toHaveBeenCalledWith(payload);
	});

	it("should not throw when 'market' callback receives invalid JSON", () => {
		// The implementation silently swallows parse errors
		expect(() => mockRust.on_market(null, "not-valid-json")).not.toThrow();
	});

	it("should forward init()", async () => {
		await stream.init({ token: "tok", name: "test" });
		expect(mockRust.init).toHaveBeenCalledWith({ token: "tok", name: "test" });
	});

	it("should forward start()", async () => {
		await stream.init();
		await stream.start();
		expect(mockRust.start).toHaveBeenCalled();
	});

	it("should auto-init on start() when not initialized", async () => {
		await stream.start();
		expect(mockRust.init).toHaveBeenCalled();
		expect(mockRust.start).toHaveBeenCalled();
	});

	it("should forward subscribe and unsubscribe", async () => {
		await stream.subscribe(["AAPL", "TSLA"]);
		expect(mockRust.subscribe).toHaveBeenCalledWith(["AAPL", "TSLA"]);

		await stream.unsubscribe(["TSLA"]);
		expect(mockRust.unsubscribe).toHaveBeenCalledWith(["TSLA"]);
	});

	it("should forward stop and clean", async () => {
		await stream.stop();
		expect(mockRust.stop).toHaveBeenCalled();

		await stream.clean();
		expect(mockRust.clean).toHaveBeenCalled();
	});
});
