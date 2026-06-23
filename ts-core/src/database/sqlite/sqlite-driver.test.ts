import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqliteConfig } from "./sqlite-config.js";
import { SqliteDriver } from "./sqlite-driver.js";

// ---------------------------------------------------------------------------
// Mock @libsql/client so connect() never touches the real network/filesystem.
// The spy tracks every execute() call so we can assert PRAGMA ordering.
// ---------------------------------------------------------------------------
const executeSpy = vi.fn().mockResolvedValue({
	rows: [],
	rowsAffected: 0,
	lastInsertRowid: null,
});
const closeSpy = vi.fn().mockResolvedValue(undefined);
const mockClient = { execute: executeSpy, close: closeSpy };

vi.mock("@libsql/client", () => ({
	createClient: vi.fn(() => mockClient),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeDriver(partial: Partial<SqliteConfig>): SqliteDriver {
	const config: SqliteConfig = {
		dialect: "sqlite",
		mode: "stateful",
		url: "file:./x.db",
		...partial,
	};
	return new SqliteDriver(config);
}

// Pull the execute calls that are PRAGMAs (plain-string form used by the driver).
function pragmaCalls(): string[] {
	return executeSpy.mock.calls
		.map((args) => {
			const arg = args[0];
			return typeof arg === "string"
				? arg
				: ((arg as { sql?: string }).sql ?? "");
		})
		.filter((s) => s.startsWith("PRAGMA"));
}

// ---------------------------------------------------------------------------
// Tests (the ORACLE — do NOT weaken these assertions)
// ---------------------------------------------------------------------------
describe("SqliteDriver PRAGMA opt-in", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Reset internal state of the driver between tests (it caches this.client).
	});

	it("issues PRAGMA journal_mode=WAL then PRAGMA synchronous=NORMAL on a local-file url", async () => {
		const driver = makeDriver({
			url: "file:./x.db",
			journalMode: "WAL",
			synchronous: "NORMAL",
		});

		await driver.connect();

		const pragmas = pragmaCalls();
		expect(pragmas).toHaveLength(2);
		expect(pragmas[0]).toBe("PRAGMA journal_mode=WAL");
		expect(pragmas[1]).toBe("PRAGMA synchronous=NORMAL");
	});

	it("issues NO PRAGMA execute calls when journalMode is absent", async () => {
		const driver = makeDriver({ url: "file:./y.db" /* no journalMode */ });

		await driver.connect();

		expect(pragmaCalls()).toHaveLength(0);
	});

	it("issues NO PRAGMA on a remote libsql url even when journalMode is set", async () => {
		const driver = makeDriver({
			url: "libsql://foo.turso.io",
			journalMode: "WAL",
			synchronous: "NORMAL",
		});

		await driver.connect();

		expect(pragmaCalls()).toHaveLength(0);
	});
});
