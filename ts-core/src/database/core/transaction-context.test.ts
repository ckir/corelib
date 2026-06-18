import { describe, expect, it } from "vitest";
import type { DbDriver } from "./driver";
import {
	getActiveTransaction,
	getActiveTxId,
	runInTransaction,
} from "./transaction-context";

describe("TransactionContext", () => {
	it("should maintain transaction state within runInTransaction", async () => {
		const mockDriver = { name: "mock-driver" } as unknown as DbDriver;

		expect(getActiveTransaction()).toBeUndefined();
		expect(getActiveTxId()).toBeUndefined();

		await runInTransaction(mockDriver, 101, async () => {
			expect(getActiveTransaction()).toBe(mockDriver);
			// Flight-recorder: the txId is carried alongside the driver.
			expect(getActiveTxId()).toBe(101);
		});

		expect(getActiveTransaction()).toBeUndefined();
		expect(getActiveTxId()).toBeUndefined();
	});

	it("should handle nested transactions", async () => {
		const outerDriver = { name: "outer" } as unknown as DbDriver;
		const innerDriver = { name: "inner" } as unknown as DbDriver;

		await runInTransaction(outerDriver, 201, async () => {
			expect(getActiveTransaction()).toBe(outerDriver);
			expect(getActiveTxId()).toBe(201);

			await runInTransaction(innerDriver, 202, async () => {
				expect(getActiveTransaction()).toBe(innerDriver);
				expect(getActiveTxId()).toBe(202);
			});

			expect(getActiveTransaction()).toBe(outerDriver);
			expect(getActiveTxId()).toBe(201);
		});
	});
});
