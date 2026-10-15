// MarketSymbols must read and write through an injected SymbolStore. Uses a hand-written in-memory fake.
import { endPoints } from "@ckirg/corelib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiNasdaqUnlimited } from "./ApiNasdaqUnlimited";
import { type MarketSymbolRow, MarketSymbols } from "./MarketSymbols";
import type { SymbolStore } from "./symbolStore";

vi.mock("basic-ftp", () => ({
	Client: class {
		access = vi.fn().mockRejectedValue(new Error("ftp unavailable (test)"));
		downloadTo = vi.fn();
		close = vi.fn();
	},
}));

vi.mock("@ckirg/corelib", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ckirg/corelib")>();
	return { ...actual, endPoints: vi.fn(), sleep: vi.fn() };
});

vi.mock("./ApiNasdaqUnlimited", () => ({
	ApiNasdaqUnlimited: { endPoint: vi.fn() },
}));

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

/** In-memory SymbolStore that records calls and can be told to throw. */
class FakeStore implements SymbolStore {
	rows = new Map<string, MarketSymbolRow>();
	calls: string[] = [];
	replaceArgs: Array<{ rows: MarketSymbolRow[]; ts: number }> = [];
	failFind = false;
	failLastRefreshTs = false;
	failCount = false;

	async init(): Promise<void> {
		this.calls.push("init");
	}
	async find(symbol: string): Promise<MarketSymbolRow | null> {
		this.calls.push(`find:${symbol}`);
		if (this.failFind) throw new Error("find boom");
		const row = this.rows.get(symbol.toUpperCase());
		return row?.active ? row : null;
	}
	async lastRefreshTs(): Promise<number | null> {
		this.calls.push("lastRefreshTs");
		if (this.failLastRefreshTs) throw new Error("lastRefreshTs boom");
		let max: number | null = null;
		for (const r of this.rows.values()) {
			if (max === null || r.ts > max) max = r.ts;
		}
		return max;
	}
	async count(): Promise<number> {
		this.calls.push("count");
		if (this.failCount) throw new Error("count boom");
		return this.rows.size;
	}
	async replaceAll(rows: MarketSymbolRow[], refreshTs: number): Promise<void> {
		this.calls.push("replaceAll");
		this.replaceArgs.push({ rows, ts: refreshTs });
		this.rows = new Map(rows.map((r) => [r.symbol, r]));
	}
	async close(): Promise<void> {
		this.calls.push("close");
	}
	seed(symbol: string, ts = Date.now()): void {
		this.rows.set(symbol, {
			symbol,
			name: `${symbol} Inc`,
			type: "rt",
			class: "stocks",
			ts,
			active: true,
		});
	}
}

describe("MarketSymbols with an injected SymbolStore", () => {
	let store: FakeStore;
	let ms: MarketSymbols;

	beforeEach(() => {
		store = new FakeStore();
		vi.mocked(endPoints).mockReset();
		vi.mocked(ApiNasdaqUnlimited.endPoint).mockReset();
		vi.mocked(ApiNasdaqUnlimited.endPoint).mockResolvedValue({
			status: "error",
			reason: { message: "no api (test)" },
		} as never);
		ms = new MarketSymbols(store, []);
	});

	afterEach(async () => {
		await ms.close();
	});

	it("uses an injected SymbolStore and never calls its close()", async () => {
		store.seed("AAPL");
		expect((await ms.get("AAPL"))?.symbol).toBe("AAPL");
		expect(store.calls).toContain("init");
		await ms.close();
		expect(store.calls).not.toContain("close");
	});

	it("refresh() replaces through store.replaceAll with rows stamped with one ts", async () => {
		vi.mocked(endPoints).mockResolvedValue(directoryResponses(1200));
		await ms.refresh();
		expect(store.replaceArgs).toHaveLength(1);
		const { rows, ts } = store.replaceArgs[0] ?? { rows: [], ts: 0 };
		expect(rows.length).toBe(2400);
		expect(new Set(rows.map((r) => r.ts))).toEqual(new Set([ts]));
		expect(store.rows.size).toBe(2400);
	});

	it("searchDb reads through store.find", async () => {
		store.seed("MSFT");
		const row = await ms.get("MSFT");
		expect(row?.name).toBe("MSFT Inc");
		expect(store.calls.some((c) => c.startsWith("find:"))).toBe(true);
		expect(ApiNasdaqUnlimited.endPoint).not.toHaveBeenCalled();
	});

	it("a thrown store.find is logged and get() falls through to the Nasdaq API", async () => {
		store.seed("AAPL");
		store.failFind = true;
		vi.mocked(ApiNasdaqUnlimited.endPoint).mockResolvedValue({
			status: "success",
			value: [{ symbol: "AAPL", name: "Apple (api)", asset: "stocks" }],
		} as never);
		const row = await ms.get("AAPL");
		expect(row?.name).toBe("Apple (api)");
		expect(ApiNasdaqUnlimited.endPoint).toHaveBeenCalledTimes(1);
	});

	it("a thrown lastRefreshTs counts as needs-refresh and a thrown count as no existing data", async () => {
		store.seed("AAPL");
		store.failLastRefreshTs = true;
		store.failCount = true;
		// Both reads throw: needs refresh and no existing data, so initialization downloads and replaces.
		vi.mocked(endPoints).mockResolvedValue(directoryResponses(1200));
		await ms.refresh();
		// Initialization downloaded once (empty-looking store), and refresh() downloads again because
		// lastRefreshTs keeps throwing, which always counts as stale.
		expect(store.replaceArgs).toHaveLength(2);
		expect(store.calls).toContain("lastRefreshTs");
		expect(store.calls).toContain("count");
	});
});
