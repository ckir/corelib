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
  // ts-core seams (Task 10)
  { seam: "external", id: "itestCore.endpoint.success", fixturePath: "itest-core/endpoint-success.json" },
  { seam: "external", id: "itestCore.endpoint.retry", fixturePath: "itest-core/endpoint-retry.json" },
  { seam: "cross-package", id: "itestCore.db.roundtrip" },
  { seam: "cross-package", id: "itestCore.config.init" },
  // ts-markets cross-package seam (Task 11)
  { seam: "cross-package", id: "xpkg.logger.child" },
  { seam: "cross-package", id: "xpkg.getTempDir" },
  { seam: "cross-package", id: "xpkg.getMode" },
  { seam: "cross-package", id: "xpkg.config" },
  // ts-markets external REST seam (Task 12)
  { seam: "external", id: "nasdaq.marketStatus.success", fixturePath: "nasdaq/market-status-success.json" },
  { seam: "external", id: "nasdaq.marketStatus.500", fixturePath: "nasdaq/market-status-500.json" },
  { seam: "external", id: "nasdaq.quotes.success", fixturePath: "nasdaq/quotes-aapl-success.json" },
  { seam: "external", id: "nasdaq.quotes.404", fixturePath: "nasdaq/quotes-404.json" },
  { seam: "external", id: "nasdaq.top100.success", fixturePath: "nasdaq/top100-success.json" },
  { seam: "external", id: "cnn.fearGreed.success", fixturePath: "cnn/fear-greed-success.json" },
  { seam: "external", id: "cnn.fearGreed.500", fixturePath: "cnn/fear-greed-500.json" },
  // TODO(itest): yahoo.historical.success — URL contains timestamps, intractable offline; record live
  // ts-cloud node project (Task 13)
  { seam: "cross-package", id: "cloud.health" },
];
