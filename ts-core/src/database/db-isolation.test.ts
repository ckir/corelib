// Pins that a transaction context is owned by the Db instance that opened it:
// db2 inside db1's transaction must not join db1's driver/connection.

import { describe, expect, it, vi } from "vitest";
import { createMockLogger } from "../test-utils/logger-mock.js";
import { wrapSuccess } from "./core/result.js";
import { createDatabase } from "./index.js";

const h = vi.hoisted(() => ({
	drivers: [] as { id: number; log: string[] }[],
}));

vi.mock("./sqlite/sqlite-driver.js", () => ({
	SqliteDriver: class {
		log: string[] = [];
		constructor() {
			h.drivers.push({ id: h.drivers.length, log: this.log });
		}
		connect = vi.fn().mockResolvedValue(undefined);
		disconnect = vi.fn().mockResolvedValue(undefined);
		query = vi.fn().mockImplementation(async (sql: string) => {
			this.log.push(sql);
			return wrapSuccess({ rows: [], affectedRows: 0 });
		});
		beginTransaction = vi.fn().mockImplementation(async () => {
			this.log.push("BEGIN");
		});
		commitTransaction = vi.fn().mockImplementation(async () => {
			this.log.push("COMMIT");
		});
		rollbackTransaction = vi.fn().mockImplementation(async () => {
			this.log.push("ROLLBACK");
		});
	},
}));

const open = () =>
	createDatabase({
		dialect: "sqlite",
		url: "file:x.db",
		mode: "stateful",
		logger: createMockLogger() as never,
	} as never);

describe("transaction context ownership", () => {
	it("db2.transaction inside db1.transaction is top-level on db2's own driver", async () => {
		h.drivers.length = 0;
		const db1 = await open();
		const db2 = await open();
		const [d1, d2] = h.drivers;
		await db1.transaction(async () => {
			await db2.transaction(async () => {
				await db2.query("SELECT 2");
				return wrapSuccess(0);
			});
			await db2.query("SELECT outside");
			await db1.query("SELECT 1");
			return wrapSuccess(0);
		});
		expect(d2.log).toEqual(["BEGIN", "SELECT 2", "COMMIT", "SELECT outside"]);
		expect(d1.log).toEqual(["BEGIN", "SELECT 1", "COMMIT"]);
		expect(d1.log.concat(d2.log).some((q) => q.startsWith("SAVEPOINT"))).toBe(
			false,
		);
	});
});
