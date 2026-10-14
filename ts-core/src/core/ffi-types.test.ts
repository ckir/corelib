// Compile-time guard: the hand-written FFI payload types must equal the typings napi generates from Rust
// (rust/index.d.ts, which CI checks for drift). napi exposes Rust snake_case fields to JS in camelCase, and
// a mismatch here means consumers read undefined fields with no compiler error. `pnpm run typecheck` enforces it.
import { describe, expectTypeOf, it } from "vitest";
import type {
	AlpacaPricingData as NativeAlpacaPricingData,
	FinnhubPricingData as NativeFinnhubPricingData,
	JsPricingData as NativeYahooPricingData,
} from "../../../rust/index";
import type {
	AlpacaPricingData,
	FinnhubPricingData,
	YahooPricingData,
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
});
