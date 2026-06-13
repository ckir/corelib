import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { assertNoMisses, beginItest, endItest, registerFixture, resetItest } from "./server";

beforeAll(() => beginItest());
afterEach(() => resetItest());

describe("itest server (replay)", () => {
  it("serves a registered fixture", async () => {
    registerFixture({
      request: { method: "GET", url: "https://itest.local/ok", headers: {} },
      response: { status: 200, headers: { "content-type": "application/json" }, body: { hello: "world" } },
      recordedAt: "2026-06-13T00:00:00.000Z",
    });
    const res = await fetch("https://itest.local/ok");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hello: "world" });
    assertNoMisses();
  });

  it("returns sequential responses from an array fixture", async () => {
    registerFixture([
      { request: { method: "GET", url: "https://itest.local/seq", headers: {} }, response: { status: 504, headers: {}, body: null }, recordedAt: "x" },
      { request: { method: "GET", url: "https://itest.local/seq", headers: {} }, response: { status: 200, headers: {}, body: { n: 2 } }, recordedAt: "x" },
    ]);
    expect((await fetch("https://itest.local/seq")).status).toBe(504);
    expect((await fetch("https://itest.local/seq")).status).toBe(200);
    assertNoMisses();
  });

  it("records a miss for an unmatched request (assertNoMisses throws)", async () => {
    await fetch("https://itest.local/unknown").catch(() => {});
    expect(() => assertNoMisses()).toThrow(/no fixture/i);
  });
});
