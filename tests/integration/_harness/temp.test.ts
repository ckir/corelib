import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupAll, createTestDatabase, getTestTempDir } from "./temp";

afterAll(async () => { await cleanupAll(); });

describe("temp isolation", () => {
  it("returns a unique existing temp dir per call", () => {
    const a = getTestTempDir();
    const b = getTestTempDir();
    expect(a).not.toBe(b);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
  });

  it("creates an isolated in-memory SQLite database", async () => {
    const db = await createTestDatabase();
    expect(db).toBeTruthy();
    // round-trip via the corelib Database interface (query returns DatabaseResult<QueryResponse>)
    await db.query("CREATE TABLE t (id INTEGER)");
    await db.query("INSERT INTO t (id) VALUES (1)");
    const res = await db.query<{ id: number }>("SELECT id FROM t");
    expect(res.status).toBe("success");
    if (res.status === "success") expect(res.value.rows.length).toBe(1);
  });
});
