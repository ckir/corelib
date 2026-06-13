import { FinnhubStreaming } from "@ckir/corelib-markets";
import { afterEach, expect, it } from "vitest";
import { assertStreamsLive, liveDescribe, requireEnv } from "@itest/_harness/guards";

liveDescribe("FinnhubStreaming (live)", () => {
  let stream: FinnhubStreaming | undefined;
  afterEach(async () => { try { await stream?.stop(); } catch { /* ignore */ } });

  it("[stream.finnhub] connects and (best-effort) emits a shaped market event", async () => {
    if (!requireEnv("finnhub", ["FINNHUB_API_KEY"])) return;
    stream = new FinnhubStreaming();
    await assertStreamsLive(stream as never, ["AAPL", "MSFT"], "finnhub");
    expect(true).toBe(true);
  });
});
