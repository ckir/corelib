// =============================================
// FILE: ts-markets/src/nasdaq/datafeeds/streaming/alpaca/AlpacaStreaming.test.ts
// PURPOSE: Exhaustive test suite for AlpacaStreaming wrapper
// Covers: constructor auto-clean (dev mode), init, start/stop, subscribe/unsubscribe,
// all events, config defaults, silence handling, error paths.
// =============================================

import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mocks to ensure they are set up before importing AlpacaStreaming
vi.mock("@ckir/corelib", () => {
	class MockAlpaca {
		on_log: any;
		on_pricing: any;
		on_event: any;
		constructor(on_log: any, on_pricing: any, on_event: any) {
			this.on_log = on_log;
			this.on_pricing = on_pricing;
			this.on_event = on_event;
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

	return {
		getMode: vi.fn(),
		getTempDir: vi.fn(() => "/tmp"),
		detectRuntime: vi.fn(() => "node"),
		coreFFI: {
			AlpacaStreaming: MockAlpaca,
		},
	};
});

import { getMode, getTempDir } from "@ckir/corelib";
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

	it("should forward subscribe and unsubscribe", async () => {
		await stream.subscribe(["AAPL", "TSLA"]);
		expect(mockRust.subscribe).toHaveBeenCalledWith(["AAPL", "TSLA"]);

		await stream.unsubscribe(["TSLA"]);
		expect(mockRust.unsubscribe).toHaveBeenCalledWith(["TSLA"]);
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
});
