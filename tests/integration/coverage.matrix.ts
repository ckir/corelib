export interface SeamCell {
  seam: "external" | "cross-package" | "ffi-scalar" | "live-streaming";
  id: string; // e.g. "nasdaq.marketStatus.500" or "stream.alpaca"
  fixturePath?: string; // required for "external"; relative to _contracts/
  testFilePath?: string; // required for "live-streaming"; relative to repo root
}

export const COVERAGE_MATRIX: SeamCell[] = [
  // ffi-scalar
  { seam: "ffi-scalar", id: "ffi.getVersion" },
  { seam: "ffi-scalar", id: "ffi.logAndDouble" },
  { seam: "ffi-scalar", id: "ffi.isFfiAvailable" },
  { seam: "ffi-scalar", id: "ffi.availabilityFallback" },
  // live-streaming (no fixtures; the suite IS the record)
  { seam: "live-streaming", id: "stream.alpaca", testFilePath: "ts-markets/tests/integration/AlpacaStreaming.live.integration.test.ts" },
  { seam: "live-streaming", id: "stream.finnhub", testFilePath: "ts-markets/tests/integration/FinnhubStreaming.live.integration.test.ts" },
  { seam: "live-streaming", id: "stream.yahoo", testFilePath: "ts-markets/tests/integration/YahooStreaming.live.integration.test.ts" },
];
