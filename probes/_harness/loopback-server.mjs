// @ts-check
/**
 * In-process TCP/WS loopback server for FFI/engine probes.
 * Provides deterministic control: frame queuing, broadcast,
 * forced disconnect (terminate), and stall simulation.
 */

import * as http from "node:http";
import { WebSocketServer } from "ws";

export class LoopbackServer {
  /** @type {http.Server | null} */
  #httpServer = null;
  /** @type {WebSocketServer | null} */
  #wss = null;
  /** @type {string[]} */
  #queue = [];
  /** @type {Set<import("ws").WebSocket>} */
  #clients = new Set();
  /** @type {boolean} */
  #paused = false;
  /** @type {number | null} */
  #port = null;

  constructor() {}

  /**
   * Bind to 127.0.0.1 on an OS-assigned ephemeral port.
   * Resolves once the server is listening.
   * @returns {Promise<void>}
   */
  listen() {
    return new Promise((resolve, reject) => {
      this.#httpServer = http.createServer();
      this.#wss = new WebSocketServer({ server: this.#httpServer });

      this.#wss.on("connection", (ws) => {
        this.#clients.add(ws);
        ws.on("close", () => this.#clients.delete(ws));
        ws.on("error", () => this.#clients.delete(ws));

        // Deliver queued frames unless paused
        if (!this.#paused) {
          for (const frame of this.#queue) {
            ws.send(frame);
          }
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
   * The WebSocket URL clients should connect to.
   * @returns {string}
   */
  get url() {
    if (this.#port === null) throw new Error("Server not listening yet");
    return `ws://127.0.0.1:${this.#port}`;
  }

  /**
   * Append a frame to the queue. Frames already in the queue
   * are delivered (in FIFO order) to each client when it connects.
   * @param {string} s
   */
  queueFrame(s) {
    this.#queue.push(s);
  }

  /**
   * Broadcast a string frame to all currently-connected clients immediately.
   * Skipped while the server is paused (blockFor).
   * @param {string} s
   */
  sendToAll(s) {
    if (this.#paused) return;
    for (const ws of this.#clients) {
      ws.send(s);
    }
  }

  /**
   * Abruptly terminate all connected sockets (non-normal close).
   * The client observes a positive close code, suitable for reconnect testing.
   * Synchronous and deterministic.
   */
  forceDisconnectAll() {
    for (const ws of this.#clients) {
      ws.terminate();
    }
    this.#clients.clear();
  }

  /**
   * Simulate a stalled/slow peer: pause send operations for `ms` milliseconds.
   * Non-blocking — auto-clears via setTimeout.
   * @param {number} ms
   */
  blockFor(ms) {
    this.#paused = true;
    setTimeout(() => {
      this.#paused = false;
    }, ms);
  }

  /**
   * Close all sockets and the underlying http+ws server.
   * @returns {Promise<void>}
   */
  close() {
    return new Promise((resolve, reject) => {
      // Terminate all connected clients first
      this.forceDisconnectAll();

      if (!this.#wss || !this.#httpServer) {
        resolve();
        return;
      }

      this.#wss.close((wssErr) => {
        if (wssErr) { reject(wssErr); return; }
        this.#httpServer.close((httpErr) => {
          if (httpErr) { reject(httpErr); return; }
          resolve();
        });
      });
    });
  }
}
