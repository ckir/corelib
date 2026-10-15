// A failed INSERT inside the refresh transaction must roll the whole refresh back. Uses a REAL in-memory
// SQLite database: with a mocked db.query that always resolves to success this defect is invisible.
import { createDatabase, endPoints } from "@ckirg/corelib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketSymbols } from "./MarketSymbols";

// FTP is the primary source now; a fast-failing client keeps these tests off the network and sends
// every download through the mocked HTTPS fallback.
vi.mock("basic-ftp", () => ({
	Client: class {
		access = vi.fn().mockRejectedValue(new Error("ftp unavailable (test)"));
		downloadTo = vi.fn();
		close = vi.fn();
	},
}));

vi.mock("@ckirg/corelib", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ckirg/corelib")>();
	return { ...actual, endPoints: vi.fn() };
});

/** A nasdaqlisted/otherlisted response pair with `n` valid rows each (symbols N0.. and O0..). */
function directoryResponses(n: number) {
	const nasdaq = Array.from(
		{ length: n },
		(_, i) => `N${i}|Name ${i}|Q|N|N|100|N|N`,
	).join("\n");
	const other = Array.from(
		{ length: n },
		(_, i) => `O${i}|Name ${i}|N|O${i}|N`,
	).join("\n");
	return [
		{
			status: "success",
			value: { body: `Symbol|Security Name|x|x|x|x|ETF|x\n${nasdaq}\n` },
		},
		{
			status: "success",
			value: {
				body: `ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol\n${other}\n`,
			},
		},
	] as never;
}

describe("MarketSymbols.performRefresh when a batch INSERT fails", () => {
	let ms: MarketSymbols | undefined;
	afterEach(async () => {
		await ms?.close();
		ms = undefined;
	});

	it("rolls back: the previous symbols stay active and no partial rows are written", async () => {
		const db = await createDatabase({
			dialect: "sqlite",
			url: ":memory:",
			mode: "stateful",
		} as never);
		// Same shape as the real table plus a constraint that makes the batch containing N5 fail.
		await db.query(`CREATE TABLE nasdaq_symbols (
			symbol TEXT PRIMARY KEY, type TEXT NOT NULL, class TEXT NOT NULL,
			name TEXT NOT NULL, ts INTEGER NOT NULL, active BOOLEAN NOT NULL DEFAULT true,
			CHECK (symbol <> 'N5'))`);
		await db.query(
			`INSERT INTO nasdaq_symbols (symbol, type, class, name, ts, active)
			 VALUES ('OLD1','rt','stocks','Old one',1,true), ('OLD2','rt','stocks','Old two',1,true)`,
		);
		vi.mocked(endPoints).mockResolvedValue(directoryResponses(1200));

		ms = new MarketSymbols(db as never, []);
		await ms.refresh().catch(() => undefined); // a surfaced failure is fine; a silent commit is not
		await (ms as unknown as { backgroundRefresh: Promise<void> | null })
			.backgroundRefresh;

		const rows = await db.query<{ n: number }>(
			"SELECT COUNT(*) AS n FROM nasdaq_symbols",
		);
		const active = await db.query<{ n: number }>(
			"SELECT COUNT(*) AS n FROM nasdaq_symbols WHERE active = true AND symbol LIKE 'OLD%'",
		);
		expect(rows.status === "success" && Number(rows.value.rows[0]?.n)).toBe(2);
		expect(active.status === "success" && Number(active.value.rows[0]?.n)).toBe(
			2,
		);
	});
});
