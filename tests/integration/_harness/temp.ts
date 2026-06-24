import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, getTempDir } from "@ckirg/corelib";

const tempDirs: string[] = [];
const closers: Array<() => Promise<void> | void> = [];

/** A unique, existing temp dir for one test. Pruned in cleanupAll(). */
export function getTestTempDir(): string {
  const base = (() => { try { return getTempDir(); } catch { return tmpdir(); } })();
  const dir = mkdtempSync(join(base, "itest-"));
  tempDirs.push(dir);
  return dir;
}

/** An isolated SQLite DB (in-memory by default). Disconnected in cleanupAll(). */
export async function createTestDatabase(opts: { file?: boolean } = {}) {
  const url = opts.file ? `file:${join(getTestTempDir(), "itest.db")}` : ":memory:";
  // mode MUST be "stateful": "stateless" disconnects after EVERY query, wiping an in-memory DB.
  const db = await createDatabase({ dialect: "sqlite", url, mode: "stateful" } as never);
  closers.push(() => db.disconnect()); // the Database interface exposes disconnect(), not close()
  return db;
}

/** Recursively prune temp dirs + disconnect DBs. Call in afterAll. */
export async function cleanupAll(): Promise<void> {
  for (const close of closers.splice(0)) { try { await close(); } catch { /* ignore */ } }
  for (const dir of tempDirs.splice(0)) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
}
