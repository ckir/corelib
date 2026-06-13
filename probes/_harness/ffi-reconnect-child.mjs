// =============================================
// CHILD HARNESS: ffi-reconnect-child.mjs  (audit B2b)
// =============================================
// Process-isolated worker for the FFI re-entrancy / TSFN deadlock probe.
// MUST be run with `--expose-gc` so `global.gc()` is callable.
//
// Hypothesis (spec §8): under rapid subscribe/unsubscribe churn + forced
// reconnects + JS GC, the Rust->JS threadsafe_function (TSFN) callback path can
// deadlock/starve (JS main thread blocked on a Rust ack) or fire after teardown
// and ABORT the process — a silent hang/crash that bypasses Vitest + JS
// try/catch. We point the ALPACA streamer at an in-process alpaca-aware
// loopback (ws://127.0.0.1:<port>) via base_url, reach the streaming state, then
// hammer it.
//
// Exercised Rust path:
//   * alpaca_streamer.rs `start` -> host.rs `start` spawns supervisor+pump
//   * alpaca_driver.rs `connect_once` (auth->subscribe->select! pump),
//     reconnect via supervisor.rs on forced disconnect
//   * the pump closure (alpaca_streamer.rs:184-221) calls on_pricing/on_market
//     TSFNs in NonBlocking mode -> this is the TSFN under test
//   * subscribe/unsubscribe -> host.subscribe_channel(_live)/unsubscribe_channel
//   * teardown via Drop (host.rs:259) aborts pump+monitor tasks
//
// Protocol (parent classifies by stdout + exit):
//   HEARTBEAT <n>   periodic liveness (forward progress)
//   DELIVERED <n>   cumulative on_pricing callbacks observed (real frame delivery)
//   READY streaming=<k>  reached streaming state on >=1 socket
//   DONE progress=<n> delivered=<m> reconnects=<r>   clean finish, exit 0
//
// On clean completion we force-exit 0 (the tokio host + redb keep libuv alive).
// We install NO panic catcher: a Rust abort MUST manifest as an abnormal exit.
// =============================================

import { coreFFI } from "../../ts-core/dist/index.js";
import { AlpacaLoopbackServer } from "./alpaca-loopback.mjs";

if (typeof global.gc !== "function") {
  console.log("NO_GC"); // parent treats this as a harness error
  process.exit(2);
}

const RUN_MS = 15_000; // <15s of churn; parent enforces a hard 20s ceiling
const RECONNECT_EVERY_MS = 400; // forced disconnect cadence -> reconnect churn
const DATA_EVERY_MS = 25; // stream trade frames into the TSFN pump
const HEARTBEAT_EVERY = 25; // print HEARTBEAT every N churn iterations (kept well
// under the parent's 5s stall window so a healthy, forward-progressing child
// always emits within budget; the inter-iter cost makes ~200 too coarse — gaps
// of ~7s between heartbeats — which the parent would misread as a stall)

const server = new AlpacaLoopbackServer();
await server.listen();

let delivered = 0; // on_pricing TSFN invocations (real frame delivery)
const noop = () => {};
const onPricing = () => {
  delivered++;
};

// Construct the streamer with the on_market_event (4th) callback present too, so
// BOTH TSFNs in the pup closure fire (alpaca_streamer.rs:189-194).
const streamer = new coreFFI.AlpacaStreaming(noop, onPricing, noop, noop);

// Point at the loopback; supply dummy creds so validate() passes.
await streamer.init({
  base_url: server.url,
  key_id: "probe-key",
  secret_key: "probe-secret",
  silence_seconds: 60,
});

// Seed a persisted subscription so the driver's initial subscribe is non-empty
// (load_subscriptions reads redb on every connect -> reaches the ack path).
await streamer.subscribe({ trades: ["AAPL"], quotes: ["AAPL"] });

await streamer.start();

let reconnects = 0;
let iter = 0;
let announcedReady = false;
const startedAt = Date.now();

// Forced reconnect churn (independent cadence).
const reconnectTimer = setInterval(() => {
  reconnects++;
  server.forceDisconnectAll();
}, RECONNECT_EVERY_MS);

// Data-frame churn: push trades into the TSFN pump for any streaming socket.
const dataTimer = setInterval(() => {
  server.streamTradeAll("AAPL", 1 + (iter % 7));
}, DATA_EVERY_MS);

async function churn() {
  while (Date.now() - startedAt < RUN_MS) {
    iter++;

    // Rapid subscribe/unsubscribe churn across channels.
    const sym = iter % 2 === 0 ? "AAPL" : "MSFT";
    await streamer.subscribe({ trades: [sym], quotes: [sym] });
    await streamer.unsubscribe({ trades: [sym] });

    // GC pressure every iteration (the §8 trigger: TSFN callback racing GC).
    global.gc();

    if (!announcedReady && server.streamingCount > 0) {
      announcedReady = true;
      console.log(`READY streaming=${server.streamingCount}`);
    }

    if (iter % HEARTBEAT_EVERY === 0) {
      console.log(`HEARTBEAT ${iter}`);
      console.log(`DELIVERED ${delivered}`);
    }

    // Yield to libuv so the loopback's connection/message events + the TSFN
    // callbacks can actually run; a tight starving loop would itself look like a
    // hang. 0ms keeps churn rapid while still draining the event loop.
    await new Promise((r) => setTimeout(r, 0));
  }
}

await churn();

clearInterval(reconnectTimer);
clearInterval(dataTimer);

await streamer.stop();
await server.close();

console.log(`DONE progress=${iter} delivered=${delivered} reconnects=${reconnects}`);
process.exit(0);
