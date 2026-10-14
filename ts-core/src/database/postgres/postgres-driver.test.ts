import { beforeEach, describe, expect, it, vi } from "vitest";

// A pool whose connections are distinguishable: each reserve() hands out a
// dedicated connection; pool-level unsafe() would land on "any" connection.
const poolUnsafe = vi.fn();
const reservedUnsafe = vi.fn();
const release = vi.fn();
const reserve = vi.fn();

vi.mock("postgres", () => ({
	default: () => {
		const pool = Object.assign(vi.fn(), {
			unsafe: poolUnsafe,
			reserve,
			end: vi.fn().mockResolvedValue(undefined),
		});
		return pool;
	},
}));

import { PostgresDriver } from "./postgres-driver.js";

const config = {
	dialect: "postgres",
	url: "postgres://x",
	mode: "stateful",
} as never;

describe("PostgresDriver transactions", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		poolUnsafe.mockResolvedValue(Object.assign([], { count: 0 }));
		reservedUnsafe.mockResolvedValue(Object.assign([], { count: 0 }));
		reserve.mockResolvedValue({ unsafe: reservedUnsafe, release });
	});

	it("runs BEGIN, queries and COMMIT on one reserved connection, never the pool", async () => {
		const base = new PostgresDriver(config);
		await base.connect();

		const tx = await base.reserve();
		await tx.beginTransaction();
		await tx.query("INSERT INTO t VALUES (1)");
		await tx.commitTransaction();

		expect(reservedUnsafe.mock.calls.map((c) => c[0])).toEqual([
			"BEGIN",
			"INSERT INTO t VALUES (1)",
			"COMMIT",
		]);
		expect(poolUnsafe).not.toHaveBeenCalled();
	});

	it("releases the reserved connection after commit and after rollback", async () => {
		const base = new PostgresDriver(config);
		await base.connect();

		const committed = await base.reserve();
		await committed.beginTransaction();
		await committed.commitTransaction();
		expect(release).toHaveBeenCalledTimes(1);

		const rolledBack = await base.reserve();
		await rolledBack.beginTransaction();
		await rolledBack.rollbackTransaction();
		expect(release).toHaveBeenCalledTimes(2);
	});

	it("releases at most once when release() is called again", async () => {
		const base = new PostgresDriver(config);
		await base.connect();

		const tx = await base.reserve();
		await tx.beginTransaction();
		await tx.rollbackTransaction();
		await tx.release();
		expect(release).toHaveBeenCalledTimes(1);
	});

	it("keeps pool queries off the reserved connection while a transaction is open", async () => {
		const base = new PostgresDriver(config);
		await base.connect();

		const tx = await base.reserve();
		await tx.beginTransaction();
		await base.query("SELECT 1");

		expect(poolUnsafe).toHaveBeenCalledWith("SELECT 1", []);
		expect(reservedUnsafe.mock.calls.map((c) => c[0])).toEqual(["BEGIN"]);
	});
});
