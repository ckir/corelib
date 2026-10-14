// =============================================
// FILE: ts-markets/src/nasdaq/datafeeds/streaming/alpaca/AlpacaStreaming.test.ts
// PURPOSE: Exhaustive test suite for AlpacaStreaming wrapper
// Covers: constructor auto-clean (dev mode), init, start/stop, subscribe/unsubscribe,
// all events, config defaults, silence handling, error paths.
// =============================================

import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mocks to ensure they are set up before importing AlpacaStreaming
vi.mock("@ckirg/corelib", () => {
	class MockAlpaca {
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
		start = vi.fn().mockImplementation(async () => {
			this.on_event(null, { type: "connected" });
		});
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
		getMode: vi.fn(),
		getTempDir: vi.fn(() => "/tmp"),
		detectRuntime: vi.fn(() => "node"),
		nextCid: () => 1,
		logger: { ...mockLog, child: () => mockLog },
		coreFFI: {
			AlpacaStreaming: MockAlpaca,
		},
	};
});

import { getMode, getTempDir, logger } from "@ckirg/corelib";
import { AlpacaStreaming } from "./AlpacaStreaming";

describe("AlpacaStreaming (Exhaustive)", () => {
	let stream: AlpacaStreaming;
	let mockRust: any;

	beforeEach(() => {
		vi.clearAllMocks();
		(getMode as any).mockReturnValue("development");
		(getTempDir as any).mockReturnValue("/tmp");

		stream = new AlpacaStreaming();
		mockRust = (stream as any).rust;
	});

	it("should auto-clean in development mode on constructor", () => {
		expect(mockRust.clean).toHaveBeenCalled();
	});

	it("should use default temp DB path when init() called without config", async () => {
		await stream.init();
		expect(mockRust.init).toHaveBeenCalledWith({
			dbPath: "/tmp/alpaca_streaming.redb",
			silenceSeconds: 60,
			baseUrl: undefined,
			keyId: undefined,
			secretKey: undefined,
		});
	});

	it("should respect custom config in init()", async () => {
		await stream.init({
			dbPath: "/custom/db.redb",
			silenceSeconds: 30,
			keyId: "test-key",
		});
		expect(mockRust.init).toHaveBeenCalledWith({
			dbPath: "/custom/db.redb",
			silenceSeconds: 30,
			baseUrl: undefined,
			keyId: "test-key",
			secretKey: undefined,
		});
	});

	it("should call start() and emit connected", async () => {
		const connectedSpy = vi.fn();
		stream.on("connected", connectedSpy);

		await stream.start();
		expect(mockRust.start).toHaveBeenCalled();
		expect(connectedSpy).toHaveBeenCalled();
	});

	it("should forward subscribe(array) as { quotes: array } to FFI", async () => {
		await stream.subscribe(["AAPL", "TSLA"]);
		expect(mockRust.subscribe).toHaveBeenCalledWith({
			quotes: ["AAPL", "TSLA"],
		});
	});

	it("should forward subscribe(opts object) unchanged to FFI", async () => {
		await stream.subscribe({ trades: ["MSFT"] });
		expect(mockRust.subscribe).toHaveBeenCalledWith({ trades: ["MSFT"] });
	});

	it("should forward unsubscribe(array) as { quotes: array } to FFI", async () => {
		await stream.unsubscribe(["TSLA"]);
		expect(mockRust.unsubscribe).toHaveBeenCalledWith({ quotes: ["TSLA"] });
	});

	it("should forward unsubscribe(opts object) unchanged to FFI", async () => {
		await stream.unsubscribe({ bars: ["SPY"] });
		expect(mockRust.unsubscribe).toHaveBeenCalledWith({ bars: ["SPY"] });
	});

	it("should forward clean and stop", async () => {
		await stream.clean();
		expect(mockRust.clean).toHaveBeenCalled();

		await stream.stop();
		expect(mockRust.stop).toHaveBeenCalled();
	});

	it("should emit pricing event", () => {
		const pricingSpy = vi.fn();
		stream.on("pricing", pricingSpy);

		const sampleData = { symbol: "AAPL", price: 150.5 } as any;
		// Simulate Rust callback
		(stream as any).rust.on_pricing(null, sampleData);

		expect(pricingSpy).toHaveBeenCalledWith(sampleData);
	});

	it("should emit log event with StrictLogger format", () => {
		const logSpy = vi.fn();
		stream.on("log", logSpy);

		const record = { level: "info", msg: "Test", extras: "{}" };
		(stream as any).rust.on_log(null, record);

		expect(logSpy).toHaveBeenCalledWith(record);
	});

	it("should emit all event types", () => {
		const events = [
			"connected",
			"disconnected",
			"reconnecting",
			"silence-reconnect",
			"error",
		];
		const spies = events.map((e) => {
			const spy = vi.fn();
			stream.on(e, spy);
			return spy;
		});

		events.forEach((e, i) => {
			(stream as any).rust.on_event(null, { type: e });
			expect(spies[i]).toHaveBeenCalled();
		});
	});

	it("should not auto-clean in production mode", () => {
		(getMode as any).mockReturnValue("production");
		const freshStream = new AlpacaStreaming();
		expect((freshStream as any).rust.clean).not.toHaveBeenCalled();
	});

	it("should handle start() before init() (auto-init)", async () => {
		const s = new AlpacaStreaming();
		await s.start();
		expect((s as any).rust.init).toHaveBeenCalled();
		expect((s as any).rust.start).toHaveBeenCalled();
	});

	it("emits 'market' when the unified 4th callback fires", () => {
		const marketSpy = vi.fn();
		stream.on("market", marketSpy);

		const payload = { type: "trade", ticker: "AAPL" };
		mockRust.on_market(null, JSON.stringify(payload));

		expect(marketSpy).toHaveBeenCalledWith(payload);
	});

	it("should not throw, not emit, and warn when 'market' callback receives invalid JSON", () => {
		// Previously pinned silent swallowing; parse failures are now logged (warn) without the raw payload.
		const marketSpy = vi.fn();
		stream.on("market", marketSpy);
		expect(() => mockRust.on_market(null, "not-valid-json")).not.toThrow();
		expect(marketSpy).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining("parse"),
			expect.objectContaining({ length: 14 }),
		);
	});

	it("ignores a native error argument: no pricing emit, no tick recorded", () => {
		const pricingSpy = vi.fn();
		stream.on("pricing", pricingSpy);
		const tick = vi.spyOn((stream as any).health, "recordTick");
		mockRust.on_pricing(new Error("napi failure"), undefined);
		expect(pricingSpy).not.toHaveBeenCalled();
		expect(tick).not.toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ error: expect.any(Error) }),
		);
	});

	it("does not throw for a native 'error' event when nobody listens", () => {
		expect(() =>
			mockRust.on_event(null, { type: "error", data: "boom" }),
		).not.toThrow();
		expect(logger.error).toHaveBeenCalled();
	});

	it("emits a native 'error' event when a listener exists", () => {
		const errSpy = vi.fn();
		stream.on("error", errSpy);
		mockRust.on_event(null, { type: "error", data: "boom" });
		expect(errSpy).toHaveBeenCalledWith("boom");
	});

	it("ignores and logs unknown native event types", () => {
		const pricingSpy = vi.fn();
		stream.on("pricing", pricingSpy);
		mockRust.on_event(null, { type: "pricing", data: 1 });
		expect(pricingSpy).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining("unknown"),
			expect.objectContaining({ type: "pricing" }),
		);
	});
});
