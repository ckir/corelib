// Compile-time guard: the hand-written FFI payload types must equal the typings napi generates from Rust
// (rust/index.d.ts, which CI checks for drift). napi exposes Rust snake_case fields to JS in camelCase, and
// a mismatch here means consumers read undefined fields with no compiler error. `pnpm run typecheck` enforces it.
import { describe, expectTypeOf, it } from "vitest";
import type {
	AlpacaConfig as NativeAlpacaConfig,
	AlpacaPricingData as NativeAlpacaPricingData,
	AlpacaStreaming as NativeAlpacaStreaming,
	EventRecord as NativeEventRecord,
	FinnhubConfig as NativeFinnhubConfig,
	FinnhubPricingData as NativeFinnhubPricingData,
	FinnhubStreaming as NativeFinnhubStreaming,
	LogRecord as NativeLogRecord,
	YahooConfig as NativeYahooConfig,
	JsPricingData as NativeYahooPricingData,
	YahooStreaming as NativeYahooStreaming,
} from "../../../rust/index";
import type {
	AlpacaConfig,
	AlpacaPricingData,
	AlpacaStreamingFFI,
	FinnhubConfig,
	FinnhubPricingData,
	FinnhubStreamingFFI,
	LogRecord,
	StreamingEvent,
	YahooConfig,
	YahooPricingData,
	YahooStreamingFFI,
} from "./ffi-types";

describe("FFI payload types match the native napi typings", () => {
	it("AlpacaPricingData", () => {
		expectTypeOf<AlpacaPricingData>().toEqualTypeOf<NativeAlpacaPricingData>();
	});

	// The native Yahoo payload struct is exported by napi as JsPricingData.
	it("YahooPricingData", () => {
		expectTypeOf<YahooPricingData>().toEqualTypeOf<NativeYahooPricingData>();
	});

	it("FinnhubPricingData", () => {
		expectTypeOf<FinnhubPricingData>().toEqualTypeOf<NativeFinnhubPricingData>();
	});

	it("config types", () => {
		expectTypeOf<AlpacaConfig>().toEqualTypeOf<NativeAlpacaConfig>();
		expectTypeOf<YahooConfig>().toEqualTypeOf<NativeYahooConfig>();
		expectTypeOf<FinnhubConfig>().toEqualTypeOf<NativeFinnhubConfig>();
	});

	it("callback record types", () => {
		expectTypeOf<LogRecord>().toEqualTypeOf<NativeLogRecord>();
		expectTypeOf<StreamingEvent>().toEqualTypeOf<NativeEventRecord>();
	});

	// The wrapper-facing instance interfaces must expose exactly the methods the native classes do.
	it("streaming class instance interfaces", () => {
		expectTypeOf<AlpacaStreamingFFI>().toEqualTypeOf<NativeAlpacaStreaming>();
		expectTypeOf<YahooStreamingFFI>().toEqualTypeOf<NativeYahooStreaming>();
		expectTypeOf<FinnhubStreamingFFI>().toEqualTypeOf<NativeFinnhubStreaming>();
	});
});
