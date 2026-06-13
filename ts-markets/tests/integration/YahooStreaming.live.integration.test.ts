import { YahooStreaming } from "@ckir/corelib-markets";
import { afterEach, expect, it } from "vitest";
import { assertStreamsLive, liveDescribe } from "@itest/_harness/guards";

liveDescribe("YahooStreaming (live)", () => {
  let stream: YahooStreaming | undefined;
  afterEach(async () => { try { await stream?.stop(); } catch { /* ignore */ } });

  it("[stream.yahoo] connects and (best-effort) emits a shaped market event", async () => {
    stream = new YahooStreaming();
    await assertStreamsLive(stream as never, ["BTC-USD"], "yahoo");
    expect(true).toBe(true);
  });
});
