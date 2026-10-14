// =============================================
// FILE: ts-core/src/database/db-hardening.test.ts
// PURPOSE: Pins (a) error/warn logs never echo SQL text or raw driver reason text,
// (b) SqliteDb serialises top-level transactions, (c) savepoint names are unique.
// Drivers are mocked; no real database is touched.
// =============================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockLogger } from "../test-utils/logger-mock.js";
import { wrapSuccess } from "./core/result.js";
import { createDatabase } from "./index.js";

const SECRET = "hunter2-SECRET-literal";

const h = vi.hoisted(() => ({
	events: [] as string[],
	queries: [] as string[],
	failMode: "result" as "result" | "throw",
}));

function makeDriverClass(withReserve: boolean) {
	return class {
		private inTx = false;
		connect = vi.fn().mockResolvedValue(undefined);
		disconnect = vi.fn().mockResolvedValue(undefined);
		query = vi.fn().mockImplementation(async (sql: string) => {
			h.queries.push(sql);
			if (sql.includes("FAIL_ME")) {
				// Mimic drivers that echo the statement on the error object.
				const err = Object.assign(new Error("syntax error at or near FAIL"), {
					code: "42601",
					query: sql,
				});
				err.stack = `Error: syntax error\n    at ${sql}`;
				if (h.failMode === "throw") throw err;
				return {
					status: "error",
					reason: {
						name: "Error",
						message: "syntax error at or near FAIL",
						code: "42601",
						query: sql,
						stack: err.stack,
					},
				};
			}
			return wrapSuccess({ rows: [], affectedRows: 0 });
		});
		beginTransaction = vi.fn().mockImplementation(async () => {
			if (this.inTx)
				throw new Error("cannot start a transaction within a transaction");
			this.inTx = true;
			h.events.push("begin");
		});
		commitTransaction = vi.fn().mockImplementation(async () => {
			this.inTx = false;
			h.events.push("commit");
		});
		rollbackTransaction = vi.fn().mockImplementation(async () => {
			this.inTx = false;
			h.events.push("rollback");
		});
		prepare = vi.fn();
		stream = vi.fn();
		reserve = withReserve
			? vi.fn().mockImplementation(async () => this)
			: undefined;
		release = withReserve ? vi.fn().mockResolvedValue(undefined) : undefined;
	};
}

vi.mock("./sqlite/sqlite-driver.js", () => ({
	SqliteDriver: makeDriverClass(false),
}));
vi.mock("./postgres/postgres-driver.js", () => ({
	PostgresDriver: makeDriverClass(true),
}));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.each([
	["sqlite", { dialect: "sqlite" as const, url: "file:x.db" }],
	["postgres", { dialect: "postgres" as const, url: "postgres://u:p@h/db" }],
])("%s hardening", (_name, base) => {
	let logger: ReturnType<typeof createMockLogger>;
	const open = async () =>
		createDatabase({
			...base,
			mode: "stateful",
			logger: logger as never,
		} as never);

	beforeEach(() => {
		logger = createMockLogger();
		h.events.length = 0;
		h.queries.length = 0;
		h.failMode = "result";
	});
	afterEach(() => vi.restoreAllMocks());

	const sensitiveLogs = () =>
		JSON.stringify([...logger.error.mock.calls, ...logger.warn.mock.calls]);

	it.each([
		"result",
		"throw",
	] as const)("does not put SQL literals in error/warn logs (%s failure)", async (mode) => {
		h.failMode = mode;
		const db = await open();
		const r = await db.query(`SELECT FAIL_ME '${SECRET}'`);
		expect(r.status).toBe("error");
		expect(logger.error).toHaveBeenCalled();
		expect(sensitiveLogs()).not.toContain(SECRET);
		// trace-level 'query: exec' is the one place SQL may appear.
		expect(JSON.stringify(logger.trace.mock.calls)).toContain(SECRET);
	});

	it("keeps message text but drops SQL from the rollback warn log", async () => {
		const db = await open();
		await db.transaction(async () => ({
			status: "error" as const,
			reason: { message: "nope", query: `SELECT '${SECRET}'` },
		}));
		expect(logger.warn).toHaveBeenCalled();
		expect(sensitiveLogs()).not.toContain(SECRET);
	});

	it("savepoint names are unique even within one millisecond", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const db = await open();
		await db.transaction(async () => {
			await db.transaction(async () => wrapSuccess(1));
			await db.transaction(async () => wrapSuccess(2));
			return wrapSuccess(0);
		});
		const names = h.queries
			.filter((q) => q.startsWith("SAVEPOINT "))
			.map((q) => q.slice("SAVEPOINT ".length));
		expect(names).toHaveLength(2);
		expect(new Set(names).size).toBe(2);
	});
});

describe("SqliteDb transaction serialisation", () => {
	beforeEach(() => {
		h.events.length = 0;
		h.queries.length = 0;
	});

	it("runs two concurrent top-level transactions one after the other", async () => {
		const db = await createDatabase({
			dialect: "sqlite",
			url: "file:x.db",
			mode: "stateful",
			logger: createMockLogger() as never,
		} as never);
		const order: string[] = [];
		const tx = (label: string, ms: number) =>
			db.transaction(async () => {
				order.push(`${label}:start`);
				await sleep(ms);
				order.push(`${label}:end`);
				return wrapSuccess(label);
			});
		const [a, b] = await Promise.all([tx("a", 20), tx("b", 1)]);
		expect(a.status).toBe("success");
		expect(b.status).toBe("success");
		expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
		expect(h.events).toEqual(["begin", "commit", "begin", "commit"]);
	});

	it("a nested transaction does not wait on the outer lock (no deadlock)", async () => {
		const db = await createDatabase({
			dialect: "sqlite",
			url: "file:x.db",
			mode: "stateful",
			logger: createMockLogger() as never,
		} as never);
		const r = await db.transaction(async () => {
			const inner = await db.transaction(async () => wrapSuccess("inner"));
			return inner;
		});
		expect(r.status).toBe("success");
	});

	it("releases the lock when a transaction fails", async () => {
		const db = await createDatabase({
			dialect: "sqlite",
			url: "file:x.db",
			mode: "stateful",
			logger: createMockLogger() as never,
		} as never);
		const bad = await db.transaction(async () => {
			throw new Error("boom");
		});
		expect(bad.status).toBe("error");
		const ok = await db.transaction(async () => wrapSuccess(1));
		expect(ok.status).toBe("success");
	});
});
