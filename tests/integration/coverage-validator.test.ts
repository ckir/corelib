import { describe, expect, it } from "vitest";
import { validateCoverage } from "./coverage-validator";

describe("coverage-validator", () => {
  it("passes for the current matrix (live-streaming test files exist; no orphan fixtures)", () => {
    const { ok, errors } = validateCoverage();
    if (!ok) console.error(errors);
    expect(ok).toBe(true);
  });
});
