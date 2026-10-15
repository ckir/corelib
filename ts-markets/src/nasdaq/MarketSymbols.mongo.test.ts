// =============================================
// FILE: ts-markets/src/nasdaq/MarketSymbols.mongo.test.ts
// PURPOSE: MarketSymbols over a REAL MongoSymbolStore (spec Testing section): fresh data skips the
// download, stale data is served while a background refresh runs, and an unreachable server is
// absorbed behind the circuit breaker. basic-ftp, endPoints and the Nasdaq API are mocked.
// =============================================

import { endPoints } from "@ckirg/corelib";
import { DateTime } from "luxon";
import { MongoClient } from "mongodb";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { describeMongo, uniqueDatabaseName } from "../test-utils/mongo";
import { ApiNasdaqUnlimited } from "./ApiNasdaqUnlimited";
import { type MarketSymbolRow, MarketSymbols } from "./MarketSymbols";
import { MongoSymbolStore } from "./mongoSymbolStore";

const ftp = vi.hoisted(() => ({ access: vi.fn() }));

// FTP always fails, so every directory download goes through the mocked endPoints fallback.
vi.mock("basic-ftp", () => ({
	Client: class {
		access = ftp.access;
		downloadTo = vi.fn();
		close = vi.fn();
	},
}));

vi.mock("@ckirg/corelib", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ckirg/corelib")>();
	return { ...actual, endPoints: vi.fn() };
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

const oldRow = (ts: number): MarketSymbolRow => ({
	symbol: "OLD1",
	name: "Old one",
	type: "rt",
	class: "stocks",
	ts,
	active: true,
});

const backgroundOf = (ms: MarketSymbols): Promise<void> | null =>
	(ms as unknown as { backgroundRefresh: Promise<void> | null })
		.backgroundRefresh;

beforeEach(() => {
	vi.clearAllMocks();
	ftp.access.mockRejectedValue(new Error("ftp unavailable (test)"));
	vi.mocked(endPoints).mockReset();
	vi.mocked(ApiNasdaqUnlimited.endPoint).mockResolvedValue({
		status: "success",
		value: [],
	} as never);
});

describeMongo("MarketSymbols over a real MongoSymbolStore", (uri) => {
	const dbName = uniqueDatabaseName("MarketSymbols.mongo.test.ts");
	let seq = 0;
	let raw: MongoClient;
	let store: MongoSymbolStore;
	let ms: MarketSymbols | undefined;

	beforeAll(() => {
		raw = new MongoClient(uri);
	});
	beforeEach(() => {
		store = new MongoSymbolStore({
			uri,
			database: dbName,
			collection: `c${++seq}`,
		});
	});
	afterEach(async () => {
		await ms?.close();
		ms = undefined;
		await store.close();
	});
	afterAll(async () => {
		await raw.db(dbName).dropDatabase();
		await raw.close();
	});

	it("refreshed today: get() serves the row from MongoDB and downloads nothing", async () => {
		await store.replaceAll([oldRow(Date.now())], Date.now());
		ms = new MarketSymbols(store);

		const found = await ms.get("OLD1");

		expect(found?.symbol).toBe("OLD1");
		expect(found?.name).toBe("Old one");
		expect(ftp.access).not.toHaveBeenCalled();
		expect(endPoints).not.toHaveBeenCalled();
		expect(ApiNasdaqUnlimited.endPoint).not.toHaveBeenCalled();
	});

	it("stale data is served at once while a background refresh replaces it", async () => {
		const threeDaysAgo = Date.now() - 3 * 24 * 3_600_000;
		await store.replaceAll([oldRow(threeDaysAgo)], threeDaysAgo);
		vi.mocked(endPoints).mockResolvedValue(directoryResponses(1200));
		ms = new MarketSymbols(store);

		const stale = await ms.get("OLD1");
		expect(stale?.symbol).toBe("OLD1");

		const background = backgroundOf(ms);
		expect(background).not.toBeNull();
		await background;
		expect(endPoints).toHaveBeenCalled();

		expect((await ms.get("N5"))?.symbol).toBe("N5");
		expect((await ms.get("O7"))?.symbol).toBe("O7");
		const ts = await store.lastRefreshTs();
		expect(ts).not.toBeNull();
		const today = DateTime.now().setZone("America/New_York").startOf("day");
		expect(
			DateTime.fromMillis(ts as number)
				.setZone("America/New_York")
				.startOf("day")
				.equals(today),
		).toBe(true);
	});
});

describe("MarketSymbols with an unreachable MongoDB", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("falls back to the Nasdaq API, never downloads the directory, and skips the store while the breaker is open", async () => {
		const init = vi.spyOn(MongoSymbolStore.prototype, "init");
		const find = vi.spyOn(MongoSymbolStore.prototype, "find");
		const ms = new MarketSymbols(
			"mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=300",
		);
		try {
			expect(await ms.get("AAPL")).toBeNull();
			expect(ApiNasdaqUnlimited.endPoint).toHaveBeenCalledTimes(1);
			expect(ftp.access).not.toHaveBeenCalled();
			expect(endPoints).not.toHaveBeenCalled();
			expect(init).toHaveBeenCalledTimes(1);
			const findCalls = find.mock.calls.length;

			expect(await ms.get("AAPL")).toBeNull();
			expect(init).toHaveBeenCalledTimes(1);
			expect(find).toHaveBeenCalledTimes(findCalls);
			expect(ApiNasdaqUnlimited.endPoint).toHaveBeenCalledTimes(2);
			expect(ftp.access).not.toHaveBeenCalled();
			expect(endPoints).not.toHaveBeenCalled();
		} finally {
			await ms.close();
		}
	});
});
