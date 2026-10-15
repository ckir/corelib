// =============================================
// FILE: ts-markets/src/nasdaq/mongoSymbolStore.test.ts
// PURPOSE: Runs the shared SymbolStore contract plus Mongo-specific refresh, registry and error tests
// against a REAL MongoDB (CORELIB_TEST_MONGODB_URI); resolveDatabaseName tests need no server.
// =============================================

import { MongoClient } from "mongodb";
import { serializeError } from "serialize-error";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { describeMongo, uniqueDatabaseName } from "../test-utils/mongo";
import type { MarketSymbolRow } from "./MarketSymbols";
import {
	__clientRegistrySize,
	MongoSymbolStore,
	resolveDatabaseName,
} from "./mongoSymbolStore";
import { SymbolStoreUnavailableError } from "./symbolStore";
import { symbolStoreContract } from "./symbolStore.contract";

function row(symbol: string, ts = 1000): MarketSymbolRow {
	return {
		symbol,
		name: `${symbol} Inc`,
		type: "rt",
		class: "stocks",
		ts,
		active: true,
	};
}

describe("resolveDatabaseName", () => {
	const cases: Array<[string, string | undefined, string]> = [
		["mongodb://h", undefined, "fb"],
		["mongodb://h/", undefined, "fb"],
		["mongodb://h/?x=1", undefined, "fb"],
		["mongodb://h/real", undefined, "real"],
		["mongodb+srv://u:p@c.example/real?x=1", undefined, "real"],
		["mongodb://h1:1,h2:2/real", undefined, "real"],
		["mongodb://h/real", "explicit", "explicit"],
		["mongodb://h", "explicit", "explicit"],
	];
	for (const [uri, explicit, expected] of cases) {
		it(`${uri} explicit=${explicit ?? "none"} -> ${expected}`, () => {
			expect(resolveDatabaseName(uri, explicit, "fb")).toBe(expected);
		});
	}
});

describeMongo("MongoSymbolStore (real MongoDB)", (uri) => {
	const dbName = uniqueDatabaseName("mongoSymbolStore.test.ts");
	let seq = 0;
	const nextCollection = (): string => `c${++seq}`;
	let raw: MongoClient;
	const opened: MongoSymbolStore[] = [];

	const make = (
		collection: string,
		extra: { onBeforeFlip?: () => Promise<void> } = {},
	): MongoSymbolStore => {
		const s = new MongoSymbolStore({
			uri,
			database: dbName,
			collection,
			...extra,
		});
		opened.push(s);
		return s;
	};
	const coll = (name: string) => raw.db(dbName).collection(name);

	beforeAll(() => {
		raw = new MongoClient(uri);
	});
	afterEach(async () => {
		await Promise.all(opened.splice(0).map((s) => s.close()));
	});
	afterAll(async () => {
		await raw.db(dbName).dropDatabase();
		await raw.close();
	});

	symbolStoreContract("MongoSymbolStore", async () => {
		const collection = nextCollection();
		return {
			store: make(collection),
			poison: (good) => [...good, row("DUP"), row("DUP")],
			cleanup: async () => {
				await Promise.all(opened.splice(0).map((s) => s.close()));
			},
		};
	});

	it("overlapping refreshes: writer A paused at onBeforeFlip, writer B completes, then A resumes -> currentGen is B's, readers saw only complete sets, A's rows are deleted", async () => {
		const c = nextCollection();
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let reached: () => void = () => {};
		const atFlip = new Promise<void>((r) => {
			reached = r;
		});
		const a = make(c, {
			onBeforeFlip: async () => {
				reached();
				await gate;
			},
		});
		const b = make(c);
		const reader = make(c);
		await Promise.all([a.init(), b.init(), reader.init()]);

		const aRows = [row("AONLY1", 1), row("AONLY2", 1), row("COMMON", 1)];
		const bRows = [row("BONLY1", 2), row("COMMON", 2)];
		const pa = a.replaceAll(aRows, 1);
		await atFlip;
		// A's rows are inserted but unflipped: readers see an empty (complete) set.
		expect(await reader.count()).toBe(0);
		expect(await reader.find("AONLY1")).toBeNull();

		await b.replaceAll(bRows, 2);
		expect(await reader.count()).toBe(bRows.length);
		release();
		await pa; // the stale flip loses; A returns successfully

		const meta = await coll(c).findOne({ _id: "meta" as never });
		expect(meta?.currentGen).toBe(2);
		expect(meta?.lastRefreshTs).toBe(2);
		expect(await coll(c).countDocuments({ gen: 1 })).toBe(0);
		expect(await reader.find("AONLY1")).toBeNull();
		expect(await reader.find("BONLY1")).toMatchObject({ symbol: "BONLY1" });
		expect(await reader.find("COMMON")).toMatchObject({ ts: 2 });
		expect(await reader.count()).toBe(bRows.length);
	});

	it("a refresh that dies before the flip leaves the old set visible; the orphan rows are unreachable at once and are removed within two successful refreshes (pruning keeps the previous generation)", async () => {
		const c = nextCollection();
		const good = make(c);
		await good.replaceAll([row("OLD1", 1), row("OLD2", 1)], 1);
		const dying = make(c, {
			onBeforeFlip: async () => {
				throw new Error("simulated crash before flip");
			},
		});
		await expect(dying.replaceAll([row("NEW1", 2)], 2)).rejects.toThrow(
			"simulated crash",
		);
		// orphan rows exist but are unreachable
		expect(await coll(c).countDocuments({ symbol: "NEW1" })).toBe(1);
		expect(await good.find("NEW1")).toBeNull();
		expect(await good.find("OLD1")).not.toBeNull();
		expect(await good.count()).toBe(2);
		expect(await good.lastRefreshTs()).toBe(1);

		await good.replaceAll([row("OLD3", 3)], 3);
		expect(await good.find("NEW1")).toBeNull();
		expect(await good.find("OLD3")).not.toBeNull();
		// Per the spec's prune rule (gen < currentGen - 1) the previous generation, which here is the
		// orphan generation, is kept for in-flight reads, so it goes with the following refresh.
		await good.replaceAll([row("OLD4", 4)], 4);
		expect(await coll(c).countDocuments({ symbol: "NEW1" })).toBe(0);
	});

	it("prune keeps the previous generation and never deletes the meta document or a newer generation", async () => {
		const c = nextCollection();
		const s = make(c);
		await s.replaceAll([row("G1", 1)], 1);
		await s.replaceAll([row("G2", 2)], 2);
		// A newer, still in-progress generation written by someone else.
		await coll(c).insertOne({
			symbol: "FUTURE",
			type: "rt",
			class: "stocks",
			name: "f",
			ts: 9,
			gen: 99,
		});
		await s.replaceAll([row("G3", 3)], 3);
		expect(await coll(c).countDocuments({ symbol: "G1" })).toBe(0);
		expect(await coll(c).countDocuments({ symbol: "G2" })).toBe(1);
		expect(await coll(c).countDocuments({ symbol: "G3" })).toBe(1);
		expect(await coll(c).countDocuments({ symbol: "FUTURE" })).toBe(1);
		const meta = await coll(c).findOne({ _id: "meta" as never });
		expect(meta).toMatchObject({ currentGen: 3, nextGen: 3, lastRefreshTs: 3 });
	});

	it("find on a store whose cached generation was pruned still returns the symbol (one re-read)", async () => {
		const c = nextCollection();
		const writer = make(c);
		const cachedReader = make(c);
		await writer.replaceAll([row("S1", 1)], 1);
		expect(await cachedReader.find("S1")).not.toBeNull(); // caches gen 1
		await writer.replaceAll([row("S2", 2)], 2);
		await writer.replaceAll([row("S3", 3)], 3); // prunes gen 1
		expect(await coll(c).countDocuments({ symbol: "S1" })).toBe(0);
		expect(await cachedReader.find("S3")).toMatchObject({ symbol: "S3" });
	});

	it("two stores on one URI: closing one leaves the other working; closing both drops __clientRegistrySize() to 0", async () => {
		const c = nextCollection();
		expect(__clientRegistrySize()).toBe(0);
		const a = make(c);
		const b = make(c);
		await a.init();
		await b.init();
		expect(__clientRegistrySize()).toBe(1);
		await a.replaceAll([row("AAPL")], 1000);
		await a.close();
		expect(__clientRegistrySize()).toBe(1);
		expect(await b.find("AAPL")).not.toBeNull();
		await b.close();
		expect(__clientRegistrySize()).toBe(0);
	});

	it("two stores calling init() concurrently on one URI construct exactly one MongoClient (registry size 1, one connect)", async () => {
		const connect = vi.spyOn(MongoClient.prototype, "connect");
		try {
			const before = connect.mock.calls.length;
			const c = nextCollection();
			const a = make(c);
			const b = make(c);
			await Promise.all([a.init(), b.init()]);
			expect(__clientRegistrySize()).toBe(1);
			expect(connect.mock.calls.length - before).toBe(1);
		} finally {
			connect.mockRestore();
		}
	});

	it("two stores initialising a fresh database at once end with one meta document and both indexes", async () => {
		const c = nextCollection();
		const stores = Array.from({ length: 4 }, () => make(c));
		await Promise.all(stores.map((s) => s.init()));
		expect(await coll(c).countDocuments({ _id: "meta" as never })).toBe(1);
		const indexes = await coll(c).indexes();
		const bySpec = (key: Record<string, number>) =>
			indexes.find((i) => JSON.stringify(i.key) === JSON.stringify(key));
		expect(bySpec({ symbol: 1, gen: 1 })?.unique).toBe(true);
		expect(bySpec({ gen: 1 })).toBeDefined();
	});

	it("ts is stored and returned as a number", async () => {
		const c = nextCollection();
		const s = make(c);
		await s.replaceAll([row("AAPL", 123456)], 123456);
		const stored = await coll(c).findOne({ symbol: "AAPL" });
		expect(typeof stored?.ts).toBe("number");
		expect(stored).not.toHaveProperty("active");
		expect(stored?.gen).toBe(1);
		const found = await s.find("aapl");
		expect(found?.ts).toBe(123456);
		expect(found?.active).toBe(true);
	});

	it("an unreachable server (127.0.0.1:1, 500 ms selection timeout) rejects with SymbolStoreUnavailableError and no part of the URI password appears in message, cause or serialized error", async () => {
		const password = "s3cretPassw0rd";
		const before = __clientRegistrySize();
		const s = new MongoSymbolStore({
			uri: `mongodb://user:${password}@127.0.0.1:1/?serverSelectionTimeoutMS=500&connectTimeoutMS=500`,
			database: dbName,
		});
		const err = await s.init().then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(SymbolStoreUnavailableError);
		const e = err as SymbolStoreUnavailableError;
		const cause = e.cause as Error;
		expect(cause).toBeInstanceOf(Error);
		const everything = [
			e.message,
			e.stack ?? "",
			cause.message,
			cause.stack ?? "",
			JSON.stringify(serializeError(e)),
		].join("\n");
		expect(everything).not.toContain(password);
		expect(__clientRegistrySize()).toBe(before);
		await s.close();
	});
});
