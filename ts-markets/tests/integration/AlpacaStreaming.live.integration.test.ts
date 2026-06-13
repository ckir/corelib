import { AlpacaStreaming } from "@ckir/corelib-markets";
import { afterEach, expect, it } from "vitest";
import { assertStreamsLive, liveDescribe, requireEnv } from "@itest/_harness/guards";

liveDescribe("AlpacaStreaming (live)", () => {
  let stream: AlpacaStreaming | undefined;
  afterEach(async () => { try { await stream?.stop(); } catch { /* ignore */ } });

  it("[stream.alpaca] connects and (best-effort) emits a shaped market event", async () => {
    if (!requireEnv("alpaca", ["APCA_API_KEY_ID", "APCA_API_SECRET_KEY"])) return;
    stream = new AlpacaStreaming();
    await assertStreamsLive(stream as never, ["AAPL", "MSFT"], "alpaca");
    expect(true).toBe(true);
  });
});
