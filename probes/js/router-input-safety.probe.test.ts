// =============================================
// PROBE: router-input-safety  (Epic 5, Phase 4, Task 4.1, Cluster 5 — external boundary)
// =============================================
// HYPOTHESIS (spec Cluster 5): the ts-cloud Hono router must, under malformed / oversized / injection
// input, (a) never crash with an unhandled throw (every request resolves with a Response), and
// (b) never echo a secret/credential VALUE from request headers/query/body into logs or the response
// body (the HARD REDACTION rule — log shapes/decisions, never secret values). A leak or crash is a
// SECURITY hard gate.
//
// DESIGN: mount the real router via `createRouter(captureLogger)` and drive `app.request(...)` with a
// battery of hostile inputs — SQLi / path-traversal / XSS / null-byte paths, an oversized path, and a
// fake secret planted in a header, the query string, and a JSON body. Assert no throw, a valid
// Response each time, and that the raw secret value appears in NEITHER the response NOR any captured
// log argument. (The router logs method+path only and the 404 reflects path-only, so header/query/body
// secrets must not surface.) Touches no production source; imports the router module under test.
// =============================================

import { describe, expect, it, vi } from "vitest";
import { createRouter } from "../../ts-cloud/src/core/router";

const SECRET_VALUE = "SUPERSECRETxyz123ABC"; // the canary; must never appear in logs/responses
const SECRET_HEADER = `Bearer ${SECRET_VALUE}`;

function captureLogger() {
  const calls: unknown[] = [];
  const rec =
    (lvl: string) =>
    (...args: unknown[]) => {
      calls.push({ lvl, args });
    };
  const logger = {
    info: vi.fn(rec("info")),
    warn: vi.fn(rec("warn")),
    error: vi.fn(rec("error")),
    debug: vi.fn(rec("debug")),
    child: vi.fn().mockReturnThis(),
    bindings: vi.fn().mockReturnValue({}),
  };
  return { logger, calls };
}

// Hostile paths — must not crash the router (each should resolve to a 404/handled Response).
const HOSTILE_PATHS = [
  "/api/v1/'; DROP TABLE users;--",
  "/api/v1/../../../../etc/passwd",
  "/api/v1/%3Cscript%3Ealert(1)%3C%2Fscript%3E",
  "/api/v1/%00%0a%0d",
  `/api/v1/${"A".repeat(20000)}`, // oversized path
  "/health", // a valid route, with secrets planted below
];

describe("router input safety (Cluster 5 security probe)", () => {
  it("malformed/injection inputs never crash and never leak request secrets", async () => {
    const { logger, calls } = captureLogger();
    const app = createRouter(logger as unknown as Parameters<typeof createRouter>[0]);
    let confirmed = false;

    for (const path of HOSTILE_PATHS) {
      let res: Response;
      try {
        // Plant the secret in a header, the query string, and a JSON body — the places real secrets live.
        res = await app.request(`${path}?token=${encodeURIComponent(SECRET_VALUE)}`, {
          method: "POST",
          headers: { authorization: SECRET_HEADER, "x-api-key": SECRET_VALUE, "content-type": "application/json" },
          body: JSON.stringify({ secret_key: SECRET_VALUE, nested: { token: SECRET_VALUE } }),
        });
      } catch (e) {
        confirmed = true;
        console.log(`PROBE_CONFIRMED router-input-safety crash_on=${path} err=${String(e)}`);
        continue;
      }
      expect(res).toBeInstanceOf(Response); // (a) no crash — always a Response
      const bodyText = await res.text();
      if (bodyText.includes(SECRET_VALUE)) {
        confirmed = true;
        console.log(`PROBE_CONFIRMED router-input-safety secret_in_response path=${path} status=${res.status}`);
      }
    }

    // (b) the raw secret value must appear in NO captured log argument.
    const loggedJson = JSON.stringify(calls);
    if (loggedJson.includes(SECRET_VALUE)) {
      confirmed = true;
      console.log("PROBE_CONFIRMED router-input-safety secret_in_logs");
    }

    if (!confirmed) {
      console.log("PROBE_CLEAN router-input-safety no-crash no-secret-leak");
    }
    // Security invariant is a HARD gate: assert no crash and no secret leak.
    expect(confirmed).toBe(false);
  });
});
