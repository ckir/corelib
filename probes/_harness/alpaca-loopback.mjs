// @ts-check
// =============================================
// HARNESS EXTENSION: alpaca-loopback.mjs  (audit B2b)
// =============================================
// A thin alpaca-protocol responder built directly on `ws`, used to drive the
// Rust AlpacaDriver state machine to its STREAMING state over a local socket so
// the TSFN pump actually fires under reconnect/GC churn.
//
// State machine mirrored from rust/.../alpaca/alpaca_driver.rs::connect_once:
//   1. on connect, server sends   [{"T":"success","msg":"connected"}]
//   2. driver sends  {"action":"auth","key":..,"secret":..}
//      server replies              [{"T":"success","msg":"authenticated"}]
//   3. driver emits Connected status, then sends
//        {"action":"subscribe", "<channel>":[...syms]}
//      server replies with a subscription control frame (best-effort ack):
//        [{"T":"subscription","trades":[...],"quotes":[...],"bars":[...]}]
//   4. driver enters its select! pump loop; server now streams queued DATA
//      frames, e.g. [{"T":"t","S":"AAPL","p":1,"s":1,"t":"<rfc3339>"}].
//
// The driver does NOT require the subscription ack to reach the pump loop (it
// fires the subscribe and falls straight into select!), so frame delivery only
// needs steps 1-2 to succeed. We send the ack anyway for fidelity.
//
// Exposes the same control surface the probe needs:
//   listen(), url, forceDisconnectAll(), streamTradeTo/streamTradeAll, close().
// =============================================

import * as http from "node:http";
import { WebSocketServer } from "ws";

const CONNECTED_FRAME = JSON.stringify([{ T: "success", msg: "connected" }]);
const AUTHED_FRAME = JSON.stringify([{ T: "success", msg: "authenticated" }]);

export class AlpacaLoopbackServer {
  /** @type {http.Server | null} */
  #httpServer = null;
  /** @type {WebSocketServer | null} */
  #wss = null;
  /** @type {Set<import("ws").WebSocket>} */
  #clients = new Set();
  /** @type {Set<import("ws").WebSocket>} */
  #streaming = new Set();
  /** @type {number | null} */
  #port = null;

  /**
   * Bind 127.0.0.1 on an ephemeral port and wire the alpaca handshake.
   * @returns {Promise<void>}
   */
  listen() {
    return new Promise((resolve, reject) => {
      this.#httpServer = http.createServer();
      this.#wss = new WebSocketServer({ server: this.#httpServer });

      this.#wss.on("connection", (ws) => {
        this.#clients.add(ws);
        ws.on("close", () => {
          this.#clients.delete(ws);
          this.#streaming.delete(ws);
        });
        ws.on("error", () => {
          this.#clients.delete(ws);
          this.#streaming.delete(ws);
        });
        ws.on("message", (raw) => this.#onMessage(ws, raw));

        // Step 1: greet with the alpaca "connected" control frame.
        try {
          ws.send(CONNECTED_FRAME);
        } catch {
          /* socket may have closed mid-churn */
        }
      });

      this.#httpServer.listen(0, "127.0.0.1", () => {
        const addr = /** @type {import("node:net").AddressInfo} */ (
          this.#httpServer.address()
        );
        this.#port = addr.port;
        resolve();
      });

      this.#httpServer.on("error", reject);
    });
  }

  /**
   * @param {import("ws").WebSocket} ws
   * @param {import("ws").RawData} raw
   */
  #onMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const action = msg && msg.action;
    if (action === "auth") {
      // Step 2: ack auth.
      this.#safeSend(ws, AUTHED_FRAME);
      return;
    }
    if (action === "subscribe") {
      // Step 3: ack subscription; mark this socket as streaming-ready.
      const ack = { T: "subscription", trades: [], quotes: [], bars: [] };
      for (const ch of ["trades", "quotes", "bars"]) {
        if (Array.isArray(msg[ch])) ack[ch] = msg[ch];
      }
      this.#safeSend(ws, JSON.stringify([ack]));
      this.#streaming.add(ws);
    }
  }

  /**
   * @param {import("ws").WebSocket} ws
   * @param {string} s
   */
  #safeSend(ws, s) {
    try {
      ws.send(s);
    } catch {
      /* peer gone */
    }
  }

  /** @returns {string} */
  get url() {
    if (this.#port === null) throw new Error("Server not listening yet");
    return `ws://127.0.0.1:${this.#port}`;
  }

  /** Number of sockets that have completed auth+subscribe and are streaming-ready. */
  get streamingCount() {
    return this.#streaming.size;
  }

  /**
   * Send one alpaca trade DATA frame to all currently-connected clients.
   * @param {string} sym
   * @param {number} price
   */
  streamTradeAll(sym = "AAPL", price = 1) {
    const frame = JSON.stringify([
      { T: "t", S: sym, p: price, s: 1, x: "V", t: new Date().toISOString() },
    ]);
    for (const ws of this.#clients) this.#safeSend(ws, frame);
  }

  /**
   * Abruptly terminate all connected sockets (non-normal close) to force the
   * Rust supervisor through a reconnect.
   */
  forceDisconnectAll() {
    for (const ws of this.#clients) {
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
    }
    this.#clients.clear();
    this.#streaming.clear();
  }

  /** @returns {Promise<void>} */
  close() {
    return new Promise((resolve) => {
      this.forceDisconnectAll();
      if (!this.#wss || !this.#httpServer) {
        resolve();
        return;
      }
      this.#wss.close(() => {
        this.#httpServer.close(() => resolve());
      });
    });
  }
}
