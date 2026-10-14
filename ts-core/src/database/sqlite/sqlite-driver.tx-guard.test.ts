import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqliteConfig } from "./sqlite-config.js";
import { SqliteDriver } from "./sqlite-driver.js";

// @libsql/client 0.18 has no client.prepare(), so against the real client prepare()/stream() fail on the
// "not supported" check regardless of the transaction guard. This mock client DOES expose prepare(), so the
// only thing that can stop prepare()/stream() from running on the shared (non-transaction) connection
// while a reserved transaction is open is the transaction guard itself.
const prepareSpy = vi.fn();
const txExecute = vi.fn().mockResolvedValue({ rows: [], rowsAffected: 0 });
const txHandle = {
	execute: txExecute,
	commit: vi.fn().mockResolvedValue(undefined),
	rollback: vi.fn().mockResolvedValue(undefined),
	close: vi.fn(),
};
const mockClient = {
	execute: vi.fn().mockResolvedValue({ rows: [], rowsAffected: 0 }),
	close: vi.fn().mockResolvedValue(undefined),
	prepare: prepareSpy,
	transaction: vi.fn().mockResolvedValue(txHandle),
};

vi.mock("@libsql/client", () => ({ createClient: vi.fn(() => mockClient) }));

const config: SqliteConfig = {
	dialect: "sqlite",
	mode: "stateful",
	url: "file:./x.db",
};

describe("SqliteDriver transaction-bound driver", () => {
	beforeEach(() => {
		prepareSpy.mockReset();
		txExecute.mockClear();
	});

	it("refuses prepare() without touching the shared connection, and stays usable", async () => {
		const tx = await new SqliteDriver(config).reserve();
		const res = await tx.prepare("SELECT 1");
		expect(res.status).toBe("error");
		expect(prepareSpy).not.toHaveBeenCalled();
		expect((await tx.query("SELECT 1")).status).toBe("success");
		expect(txExecute).toHaveBeenCalledTimes(1);
	});

	it("refuses stream() without touching the shared connection", async () => {
		const tx = await new SqliteDriver(config).reserve();
		const rows: unknown[] = [];
		const res = await tx.stream("SELECT 1", [], (r) => {
			rows.push(r);
		});
		expect(res.status).toBe("error");
		expect(prepareSpy).not.toHaveBeenCalled();
		expect(rows).toEqual([]);
	});

	it("still prepares on a plain (non-transaction) driver", async () => {
		prepareSpy.mockReturnValue({ execute: vi.fn(), close: vi.fn() });
		const driver = new SqliteDriver(config);
		await driver.connect();
		expect((await driver.prepare("SELECT 1")).status).toBe("success");
		expect(prepareSpy).toHaveBeenCalledTimes(1);
	});
});
