import { describe, expect, it } from "vitest";
import { type Fixture, findUnscrubbedSecrets, scrubFixture } from "./scrubber";

const REDACTED = "<REDACTED>";

function baseFixture(over: Partial<Fixture> = {}): Fixture {
  return {
    request: { method: "GET", url: "https://api.example.com/x", headers: {} },
    response: { status: 200, headers: {}, body: null },
    recordedAt: "2026-06-13T00:00:00.000Z",
    ...over,
  };
}

describe("scrubFixture", () => {
  it("redacts denylisted headers (case-insensitive) in request and response", () => {
    const f = baseFixture({
      request: { method: "GET", url: "https://x/y", headers: { Authorization: "Bearer abc", "X-API-Key": "k1" } },
      response: { status: 200, headers: { "Set-Cookie": "s=1" }, body: null },
    });
    const s = scrubFixture(f);
    expect(s.request.headers.Authorization).toBe(REDACTED);
    expect(s.request.headers["X-API-Key"]).toBe(REDACTED);
    expect(s.response.headers["Set-Cookie"]).toBe(REDACTED);
  });

  it("redacts query-string secrets in the url", () => {
    const f = baseFixture({ request: { method: "GET", url: "https://x/y?apikey=SECRET&q=1", headers: {} } });
    const s = scrubFixture(f);
    expect(s.request.url).toContain("apikey=" + REDACTED);
    expect(s.request.url).toContain("q=1");
  });

  it("recursively redacts secret-named keys in object bodies", () => {
    const f = baseFixture({
      response: { status: 200, headers: {}, body: { keyId: "K", secretKey: "S", nested: { token: "T", ok: 1 } } },
    });
    const s = scrubFixture(f);
    const b = s.response.body as any;
    expect(b.keyId).toBe(REDACTED);
    expect(b.secretKey).toBe(REDACTED);
    expect(b.nested.token).toBe(REDACTED);
    expect(b.nested.ok).toBe(1);
  });

  it("redacts secrets inside JSON string bodies, re-serializing", () => {
    const f = baseFixture({ response: { status: 200, headers: {}, body: JSON.stringify({ apiKey: "A", x: 2 }) } });
    const s = scrubFixture(f);
    const parsed = JSON.parse(s.response.body as string);
    expect(parsed.apiKey).toBe(REDACTED);
    expect(parsed.x).toBe(2);
  });
});

describe("findUnscrubbedSecrets", () => {
  it("returns reasons when a denylisted value is still present", () => {
    const f = baseFixture({ request: { method: "GET", url: "https://x?token=LIVE", headers: { cookie: "c=1" } } });
    expect(findUnscrubbedSecrets(f).length).toBeGreaterThan(0);
  });
  it("returns empty for a fully scrubbed fixture", () => {
    const f = scrubFixture(baseFixture({ request: { method: "GET", url: "https://x?token=LIVE", headers: { cookie: "c=1" } } }));
    expect(findUnscrubbedSecrets(f)).toEqual([]);
  });
});
