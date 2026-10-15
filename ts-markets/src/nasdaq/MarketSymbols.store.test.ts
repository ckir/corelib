// MarketSymbols must read and write through an injected SymbolStore. Uses a hand-written in-memory fake.
import { ConfigManager, endPoints } from "@ckirg/corelib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiNasdaqUnlimited } from "./ApiNasdaqUnlimited";
import { type MarketSymbolRow, MarketSymbols } from "./MarketSymbols";
import { type SymbolStore, SymbolStoreUnavailableError } from "./symbolStore";

const ftpAccess = vi.hoisted(() => vi.fn());

vi.mock("basic-ftp", () => ({
	Client: class {
		access = ftpAccess;
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
	/** Store methods that throw SymbolStoreUnavailableError (an unreachable backend). */
	unavailableOn = new Set<string>();

	private checkAvailable(method: string): void {
		if (this.unavailableOn.has(method)) {
			throw new SymbolStoreUnavailableError(`${method} unreachable (test)`);
		}
	}

	async init(): Promise<void> {
		this.calls.push("init");
		this.checkAvailable("init");
	}
	async find(symbol: string): Promise<MarketSymbolRow | null> {
		this.calls.push(`find:${symbol}`);
		this.checkAvailable("find");
		if (this.failFind) throw new Error("find boom");
		const row = this.rows.get(symbol.toUpperCase());
		return row?.active ? row : null;
	}
	async lastRefreshTs(): Promise<number | null> {
		this.calls.push("lastRefreshTs");
		this.checkAvailable("lastRefreshTs");
		if (this.failLastRefreshTs) throw new Error("lastRefreshTs boom");
		let max: number | null = null;
		for (const r of this.rows.values()) {
			if (max === null || r.ts > max) max = r.ts;
		}
		return max;
	}
	async count(): Promise<number> {
		this.calls.push("count");
		this.checkAvailable("count");
		if (this.failCount) throw new Error("count boom");
		return this.rows.size;
	}
	async replaceAll(rows: MarketSymbolRow[], refreshTs: number): Promise<void> {
		this.calls.push("replaceAll");
		this.checkAvailable("replaceAll");
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
		ftpAccess.mockReset();
		ftpAccess.mockRejectedValue(new Error("ftp unavailable (test)"));
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

	it("a thrown lastRefreshTs counts as needs-refresh", async () => {
		store.seed("AAPL");
		store.failLastRefreshTs = true;
		vi.mocked(endPoints).mockResolvedValue(directoryResponses(1200));
		await ms.refresh();
		// lastRefreshTs keeps throwing, which counts as stale, so refresh() downloads and replaces.
		expect(store.replaceArgs.length).toBeGreaterThanOrEqual(1);
		expect(store.calls).toContain("lastRefreshTs");
	});

	it("a thrown count counts as no existing data", async () => {
		// Stale rows plus a failing count: with "no existing data" initialization waits for the download.
		store.seed("AAPL", 1);
		store.failCount = true;
		vi.mocked(endPoints).mockResolvedValue(directoryResponses(1200));
		const row = await ms.get("N5");
		expect(row?.symbol).toBe("N5");
		expect(store.calls).toContain("count");
	});
});

describe("MarketSymbols circuit breaker for an unavailable store", () => {
	let store: FakeStore;
	let ms: MarketSymbols;

	/** Lets fire-and-forget work (the hourly freshness check) settle. */
	const settle = () => new Promise<void>((r) => setImmediate(r));
	const finds = () => store.calls.filter((c) => c.startsWith("find:")).length;

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		store = new FakeStore();
		vi.mocked(endPoints).mockReset();
		ftpAccess.mockReset();
		ftpAccess.mockRejectedValue(new Error("ftp unavailable (test)"));
		vi.mocked(ApiNasdaqUnlimited.endPoint).mockReset();
		vi.mocked(ApiNasdaqUnlimited.endPoint).mockResolvedValue({
			status: "error",
			reason: { message: "no api (test)" },
		} as never);
		ms = new MarketSymbols(store, []);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await ms.close();
		vi.useRealTimers();
	});

	it("find during an outage returns null without calling the store while the breaker is open", async () => {
		store.seed("AAPL");
		store.unavailableOn.add("find");
		expect(await ms.get("AAPL")).toBeNull();
		expect(finds()).toBe(1);
		expect(await ms.get("AAPL")).toBeNull();
		expect(await ms.get("MSFT")).toBeNull();
		expect(finds()).toBe(1);
	});

	it("the breaker closes after the period and a success keeps it closed", async () => {
		store.seed("AAPL");
		store.unavailableOn.add("find");
		await ms.get("AAPL");
		store.unavailableOn.clear();
		vi.advanceTimersByTime(29_000);
		expect(await ms.get("AAPL")).toBeNull();
		expect(finds()).toBe(1);
		vi.advanceTimersByTime(2_000);
		expect((await ms.get("AAPL"))?.symbol).toBe("AAPL");
		expect((await ms.get("AAPL"))?.symbol).toBe("AAPL");
		expect(finds()).toBe(3);
	});

	it("reads the breaker period from markets.nasdaq.symbols.breaker when it opens", async () => {
		store.seed("AAPL");
		vi.spyOn(ConfigManager, "get").mockImplementation((key: string) =>
			key === "markets.nasdaq.symbols.breaker" ? 5_000 : undefined,
		);
		store.unavailableOn.add("find");
		await ms.get("AAPL");
		store.unavailableOn.clear();
		vi.advanceTimersByTime(5_001);
		expect((await ms.get("AAPL"))?.symbol).toBe("AAPL");
	});

	it("lastRefreshTs/count failures with the breaker open trigger no download (endPoints and basic-ftp mocks not called)", async () => {
		store.unavailableOn.add("lastRefreshTs");
		expect(await ms.get("N1")).toBeNull();
		expect(await ms.get("N1")).toBeNull();
		await expect(ms.refresh()).rejects.toBeInstanceOf(
			SymbolStoreUnavailableError,
		);
		expect(endPoints).not.toHaveBeenCalled();
		expect(ftpAccess).not.toHaveBeenCalled();
		expect(store.calls).not.toContain("replaceAll");
		expect(store.calls.filter((c) => c === "lastRefreshTs")).toHaveLength(1);
	});

	it("an unavailable count on a stale store triggers no download either", async () => {
		store.seed("AAPL", 1);
		store.unavailableOn.add("count");
		expect(await ms.get("AAPL")).toBeNull();
		expect(endPoints).not.toHaveBeenCalled();
		expect(ftpAccess).not.toHaveBeenCalled();
		expect(store.calls).not.toContain("replaceAll");
	});

	it("ensureInitialized fails fast while open and does not reach performRefresh", async () => {
		store.unavailableOn.add("init");
		await expect(ms.refresh()).rejects.toBeInstanceOf(
			SymbolStoreUnavailableError,
		);
		const performRefresh = vi.spyOn(
			ms as unknown as { performRefresh: () => Promise<void> },
			"performRefresh",
		);
		store.unavailableOn.clear();
		await expect(ms.refresh()).rejects.toBeInstanceOf(
			SymbolStoreUnavailableError,
		);
		expect(store.calls.filter((c) => c === "init")).toHaveLength(1);
		expect(performRefresh).not.toHaveBeenCalled();
		expect(endPoints).not.toHaveBeenCalled();
	});

	it("the hourly freshness check starts no background refresh while the store is unavailable", async () => {
		store.seed("AAPL");
		expect((await ms.get("AAPL"))?.symbol).toBe("AAPL");
		vi.advanceTimersByTime(3_600_001);
		store.unavailableOn.add("lastRefreshTs");
		await ms.get("AAPL");
		await settle();
		expect(
			(ms as unknown as { backgroundRefresh: unknown }).backgroundRefresh,
		).toBeNull();
		expect(endPoints).not.toHaveBeenCalled();
		expect(ftpAccess).not.toHaveBeenCalled();
	});

	it("an ordinary Error keeps today's semantics and does not open the breaker", async () => {
		store.seed("AAPL");
		store.failFind = true;
		expect(await ms.get("AAPL")).toBeNull();
		expect(await ms.get("AAPL")).toBeNull();
		expect(finds()).toBe(2);
		store.failFind = false;
		expect((await ms.get("AAPL"))?.symbol).toBe("AAPL");
	});

	it("get() never throws a store error", async () => {
		for (const m of ["init", "find", "lastRefreshTs", "count", "replaceAll"]) {
			store.unavailableOn.add(m);
		}
		await expect(ms.get("AAPL")).resolves.toBeNull();
		await expect(ms.get("AAPL")).resolves.toBeNull();
	});
});
