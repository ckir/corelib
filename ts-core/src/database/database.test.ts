import { afterEach, describe, expect, it, vi } from "vitest";
import { wrapSuccess } from "./core/result.js";
import { createDatabase } from "./index.js";

// Mock logger
const mockLogger = {
	error: vi.fn(),
	warn: vi.fn(),
	debug: vi.fn(),
	info: vi.fn(),
	child: vi.fn().mockReturnThis(),
} as any;

// Comprehensive Mock for both drivers
vi.mock("./sqlite/sqlite-driver.js", () => {
	return {
		SqliteDriver: class {
			connect = vi.fn().mockResolvedValue(undefined);
			disconnect = vi.fn().mockResolvedValue(undefined);
			query = vi
				.fn()
				.mockResolvedValue(
					wrapSuccess({ rows: [{ num: 1 }], affectedRows: 0 }),
				);
			prepare = vi.fn().mockResolvedValue(
				wrapSuccess({
					execute: vi
						.fn()
						.mockResolvedValue(
							wrapSuccess({ rows: [{ num: 1 }], affectedRows: 0 }),
						),
					close: vi.fn().mockResolvedValue(undefined),
				}),
			);
			beginTransaction = vi.fn().mockResolvedValue(undefined);
			commitTransaction = vi.fn().mockResolvedValue(undefined);
			rollbackTransaction = vi.fn().mockResolvedValue(undefined);
			stream = vi.fn().mockResolvedValue(wrapSuccess(undefined));
		},
	};
});

vi.mock("./postgres/postgres-driver.js", () => {
	return {
		PostgresDriver: class {
			connect = vi.fn().mockResolvedValue(undefined);
			disconnect = vi.fn().mockResolvedValue(undefined);
			query = vi.fn().mockImplementation(async (sql: string) => {
				if (sql === "INVALID SQL")
					return { status: "error", reason: { message: "error" } };
				if (sql.includes("SELECT 1"))
					return wrapSuccess({ rows: [{ num: 1 }], affectedRows: 0 });
				if (sql.includes("RETURNING id"))
					return wrapSuccess({ rows: [{ id: 1 }], affectedRows: 1 });
				return wrapSuccess({ rows: [], affectedRows: 0 });
			});
			prepare = vi.fn().mockResolvedValue(
				wrapSuccess({
					execute: vi
						.fn()
						.mockResolvedValue(
							wrapSuccess({ rows: [{ val: 1 }], affectedRows: 0 }),
						),
					close: vi.fn().mockResolvedValue(undefined),
				}),
			);
			beginTransaction = vi.fn().mockResolvedValue(undefined);
			commitTransaction = vi.fn().mockResolvedValue(undefined);
			rollbackTransaction = vi.fn().mockResolvedValue(undefined);
			stream = vi.fn().mockImplementation(async (_sql, _params, onRow) => {
				onRow({ id: 1 });
				onRow({ id: 2 });
				return wrapSuccess(undefined);
			});
		},
	};
});

describe("Database Integration Tests (Mocked Drivers)", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	describe("SQLite Database", () => {
		it("should execute query successfully", async () => {
			const db = await createDatabase({
				dialect: "sqlite",
				url: "libsql://:memory:",
				mode: "stateful",
				logger: mockLogger,
			});
			const result = await db.query("SELECT 1 as num");
			expect(result.status).toBe("success");
			if (result.status === "success") {
				expect(result.value.rows[0].num).toBe(1);
			}
		});
	});

	describe("Postgres Database", () => {
		it("should execute query successfully", async () => {
			const db = await createDatabase({
				dialect: "postgres",
				url: "dummy",
				mode: "stateful",
				logger: mockLogger,
			});
			const result = await db.query("SELECT 1 as num");
			expect(result.status).toBe("success");
			if (result.status === "success") {
				expect(result.value.rows[0].num).toBe(1);
			}
		});

		it("should handle query error", async () => {
			const db = await createDatabase({
				dialect: "postgres",
				url: "dummy",
				mode: "stateful",
				logger: mockLogger,
			});
			const result = await db.query("INVALID SQL");
			expect(result.status).toBe("error");
			expect(mockLogger.error).toHaveBeenCalled();
		});

		it("should handle transaction success", async () => {
			const db = await createDatabase({
				dialect: "postgres",
				url: "dummy",
				mode: "stateful",
				logger: mockLogger,
			});
			const result = await db.transaction(async () => {
				return wrapSuccess(true);
			});
			expect(result.status).toBe("success");
		});

		it("should rollback on transaction error", async () => {
			const db = await createDatabase({
				dialect: "postgres",
				url: "dummy",
				mode: "stateful",
				logger: mockLogger,
			});
			const result = await db.transaction(async () => {
				return { status: "error", reason: { message: "Test error" } };
			});
			expect(result.status).toBe("error");
			expect(mockLogger.warn).toHaveBeenCalledWith(
				"Transaction rollback initiated",
				expect.any(Object),
			);
		});

		it("should prepare and execute statement", async () => {
			const db = await createDatabase({
				dialect: "postgres",
				url: "dummy",
				mode: "stateful",
				logger: mockLogger,
			});
			const prepResult = await (db as any).driver.prepare("SELECT 1 as val");
			expect(prepResult.status).toBe("success");
			if (prepResult.status === "success") {
				const execResult = await prepResult.value.execute();
				expect(execResult.status).toBe("success");
				if (execResult.status === "success") {
					expect(execResult.value.rows[0].val).toBe(1);
				}
			}
		});

		it("should stream rows", async () => {
			const db = await createDatabase({
				dialect: "postgres",
				url: "dummy",
				mode: "stateful",
				logger: mockLogger,
			});
			const rows: number[] = [];
			const result = await (db as any).driver.stream(
				"SELECT id FROM test",
				[],
				(row: any) => rows.push(row.id),
			);
			expect(result.status).toBe("success");
			expect(rows).toEqual([1, 2]);
		});

		it("should use stateless mode", async () => {
			const db = await createDatabase({
				dialect: "postgres",
				url: "dummy",
				mode: "stateless",
				logger: mockLogger,
			});
			const spyConnect = (db as any).driver.connect;
			const spyDisconnect = (db as any).driver.disconnect;
			await db.query("SELECT 1");
			expect(spyConnect).toHaveBeenCalled();
			expect(spyDisconnect).toHaveBeenCalled();
		});

		it("should handle RETURNING for insert ID", async () => {
			const db = await createDatabase({
				dialect: "postgres",
				url: "dummy",
				mode: "stateful",
				logger: mockLogger,
			});
			const result = await db.query("INSERT INTO test RETURNING id");
			expect(result.status).toBe("success");
			if (result.status === "success") {
				expect(result.value.rows[0].id).toBe(1);
			}
		});
	});
});
