// Compile-time guard: the hand-written FFI payload types must equal the typings napi generates from Rust
// (rust/index.d.ts, which CI checks for drift). napi exposes Rust snake_case fields to JS in camelCase, and
// a mismatch here means consumers read undefined fields with no compiler error. `pnpm run typecheck` enforces it.
import { describe, expectTypeOf, it } from "vitest";
import type { FinnhubPricingData as NativeFinnhubPricingData } from "../../../rust/index";
import type { FinnhubPricingData } from "./ffi-types";

describe("FFI payload types match the native napi typings", () => {
	it("FinnhubPricingData", () => {
		expectTypeOf<FinnhubPricingData>().toEqualTypeOf<NativeFinnhubPricingData>();
	});
});
