import { describe, expect, it } from "vitest";
import type { DbDriver } from "./driver";
import { getActiveTransaction, runInTransaction } from "./transaction-context";

describe("TransactionContext", () => {
	it("should maintain transaction state within runInTransaction", async () => {
		const mockDriver = { name: "mock-driver" } as unknown as DbDriver;

		expect(getActiveTransaction()).toBeUndefined();

		await runInTransaction(mockDriver, async () => {
			expect(getActiveTransaction()).toBe(mockDriver);
		});

		expect(getActiveTransaction()).toBeUndefined();
	});

	it("should handle nested transactions", async () => {
		const outerDriver = { name: "outer" } as unknown as DbDriver;
		const innerDriver = { name: "inner" } as unknown as DbDriver;

		await runInTransaction(outerDriver, async () => {
			expect(getActiveTransaction()).toBe(outerDriver);

			await runInTransaction(innerDriver, async () => {
				expect(getActiveTransaction()).toBe(innerDriver);
			});

			expect(getActiveTransaction()).toBe(outerDriver);
		});
	});
});
