// SqliteDb.transaction must be ATOMIC. @libsql/client's pool rolls back any transaction still open when
// execute() returns its connection, so a BEGIN sent through client.execute() never survives to the next
// statement. These tests run against a REAL libsql database (in-memory and file-backed); mocks cannot show this.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { type DatabaseResult, wrapSuccess } from "./../core/result.js";
import { createDatabase } from "../index.js";

type Db = Awaited<ReturnType<typeof createDatabase>>;

const dir = mkdtempSync(join(tmpdir(), "sqlite-atomicity-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const targets: Array<[string, () => string]> = [
	["in-memory", () => ":memory:"],
	[
		"file",
		() => `file:${join(dir, `db-${Math.random().toString(36).slice(2)}.db`)}`,
	],
];

const num = async (db: Db, sql: string): Promise<number> => {
	const r = await db.query<{ n: number | bigint }>(sql);
	if (r.status !== "success") throw new Error(`query failed: ${sql}`);
	return Number(r.value.rows[0]?.n);
};

describe.each(targets)("SqliteDb.transaction atomicity (%s)", (_name, url) => {
	const open: Db[] = [];
	afterEach(async () => {
		for (const db of open.splice(0)) await db.disconnect();
	});

	const fresh = async (): Promise<Db> => {
		const db = await createDatabase({
			dialect: "sqlite",
			url: url(),
			mode: "stateful",
		} as never);
		open.push(db);
		await db.query(
			"CREATE TABLE t (symbol TEXT PRIMARY KEY, active BOOLEAN NOT NULL DEFAULT true, CHECK (symbol <> 'BAD'))",
		);
		await db.query("INSERT INTO t VALUES ('OLD1', true), ('OLD2', true)");
		return db;
	};

	it("rolls back earlier statements when a later statement fails", async () => {
		const db = await fresh();
		const result = await db.transaction(async () => {
			await db.query("UPDATE t SET active = false");
			const bad = await db.query("INSERT INTO t VALUES ('BAD', true)");
			return bad.status === "error"
				? (bad as unknown as DatabaseResult<null>)
				: wrapSuccess(null);
		});
		expect(result.status).toBe("error");
		expect(
			await num(db, "SELECT COUNT(*) AS n FROM t WHERE active = true"),
		).toBe(2);
	});

	it("rolls back and leaves the database usable when the callback throws", async () => {
		const db = await fresh();
		const result = await db.transaction(async () => {
			await db.query("UPDATE t SET active = false");
			throw new Error("boom");
		});
		expect(result.status).toBe("error");
		expect(
			await num(db, "SELECT COUNT(*) AS n FROM t WHERE active = true"),
		).toBe(2);
		// no leaked handle: another transaction and a plain query both still work
		const again = await db.transaction(async () => {
			await db.query("INSERT INTO t VALUES ('NEW', true)");
			return wrapSuccess(null);
		});
		expect(again.status).toBe("success");
		expect(await num(db, "SELECT COUNT(*) AS n FROM t")).toBe(3);
	});

	it("rolls a nested transaction back to its savepoint without ending the outer one", async () => {
		const db = await fresh();
		const result = await db.transaction(async () => {
			await db.query("INSERT INTO t VALUES ('A', true)");
			await db.transaction(async () => {
				await db.query("INSERT INTO t VALUES ('B', true)");
				return {
					status: "error",
					reason: "inner failed",
				} as unknown as DatabaseResult<null>;
			});
			return wrapSuccess(null);
		});
		expect(result.status).toBe("success");
		expect(
			await num(db, "SELECT COUNT(*) AS n FROM t WHERE symbol = 'A'"),
		).toBe(1);
		expect(
			await num(db, "SELECT COUNT(*) AS n FROM t WHERE symbol = 'B'"),
		).toBe(0);
	});

	it("serializes concurrent top-level transactions (read-modify-write stays consistent)", async () => {
		const db = await fresh();
		await db.query("CREATE TABLE c (n INTEGER NOT NULL)");
		await db.query("INSERT INTO c VALUES (0)");
		const bump = () =>
			db.transaction(async () => {
				const n = await num(db, "SELECT n FROM c");
				await new Promise((r) => setTimeout(r, 5));
				await db.query("UPDATE c SET n = ?", [n + 1]);
				return wrapSuccess(null);
			});
		const results = await Promise.all([bump(), bump(), bump()]);
		expect(results.map((r) => r.status)).toEqual([
			"success",
			"success",
			"success",
		]);
		expect(await num(db, "SELECT n FROM c")).toBe(3);
	});

	it("rolls back and stays usable when COMMIT itself fails (deferred foreign key)", async () => {
		const db = await fresh();
		await db.query("PRAGMA foreign_keys = ON");
		await db.query("CREATE TABLE parent (id INTEGER PRIMARY KEY)");
		await db.query(
			"CREATE TABLE child (pid INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)",
		);
		const result = await db.transaction(async () => {
			await db.query("INSERT INTO child VALUES (99)"); // violation surfaces only at COMMIT
			return wrapSuccess(null);
		});
		expect(result.status).toBe("error");
		expect(await num(db, "SELECT COUNT(*) AS n FROM child")).toBe(0);
		expect(await num(db, "SELECT COUNT(*) AS n FROM t")).toBe(2); // plain query still works
	});
});
