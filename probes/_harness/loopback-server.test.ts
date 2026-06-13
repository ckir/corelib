import { afterAll, beforeAll, expect, test } from "vitest";
import { WebSocket } from "ws";
import { LoopbackServer } from "./loopback-server.mjs";

let server: LoopbackServer;
beforeAll(async () => { server = new LoopbackServer(); await server.listen(); });
afterAll(async () => { await server.close(); });

test("client connects, receives a queued frame, and observes forced disconnect", async () => {
  server.queueFrame(JSON.stringify({ T: "t", S: "AAPL", p: 1 }));
  const ws = new WebSocket(server.url);
  const first = await new Promise<string>((res) => ws.on("message", (d) => res(d.toString())));
  expect(JSON.parse(first).S).toBe("AAPL");
  server.forceDisconnectAll();           // deterministic disconnect for reconnect probes
  const closed = await new Promise<number>((res) => ws.on("close", (c) => res(c)));
  expect(closed).toBeGreaterThan(0);
});
