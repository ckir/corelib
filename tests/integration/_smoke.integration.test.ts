import { describe, expect, it } from "vitest";

describe("itest smoke", () => {
  it("runs under the integration config", () => {
    expect(1 + 1).toBe(2);
  });
});
