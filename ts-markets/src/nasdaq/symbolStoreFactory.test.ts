// =============================================
// FILE: ts-markets/src/nasdaq/symbolStoreFactory.test.ts
// PURPOSE: createSymbolStore picks the symbol store from the argument, then from configuration.
// =============================================

import { ConfigManager, type Database, getTempDir } from "@ckirg/corelib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MongoSymbolStore } from "./mongoSymbolStore";
import { SqlSymbolStore } from "./sqlSymbolStore";
import type { SymbolStore } from "./symbolStore";
import { createSymbolStore } from "./symbolStoreFactory";

const mocks = vi.hoisted(() => ({
	mongoCtor: vi.fn(),
	getEnv: vi.fn(),
	detectRuntime: vi.fn(),
	info: vi.fn(),
}));

vi.mock("./mongoSymbolStore", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./mongoSymbolStore")>();
	class SpyMongoSymbolStore extends actual.MongoSymbolStore {
		constructor(
			options: ConstructorParameters<typeof actual.MongoSymbolStore>[0],
		) {
			mocks.mongoCtor(options);
			super(options);
		}
	}
	return { ...actual, MongoSymbolStore: SpyMongoSymbolStore };
});

vi.mock("@ckirg/corelib", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ckirg/corelib")>();
	const child = () => ({
		info: mocks.info,
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	});
	return {
		...actual,
		getEnv: mocks.getEnv,
		detectRuntime: mocks.detectRuntime,
		logger: { ...actual.logger, child },
	};
});

let config: Record<string, unknown>;
let env: Record<string, string | undefined>;

beforeEach(() => {
	vi.restoreAllMocks();
	mocks.info.mockReset();
	mocks.mongoCtor.mockReset();
	config = {};
	env = {};
	mocks.getEnv.mockImplementation((k: string) => env[k]);
	mocks.detectRuntime.mockReturnValue("node");
	vi.spyOn(ConfigManager, "get").mockImplementation((p: string) => config[p]);
	vi.spyOn(SqlSymbolStore, "fromConfig");
	vi.spyOn(SqlSymbolStore, "fromDatabase");
});

const fakeStore = (): SymbolStore =>
	({
		replaceAll: vi.fn(),
		init: vi.fn(),
	}) as unknown as SymbolStore;

describe("createSymbolStore with an argument", () => {
	it("passes a SymbolStore through and logs injected-store", () => {
		const s = fakeStore();
		expect(createSymbolStore(s)).toBe(s);
		expect(mocks.info).toHaveBeenCalledWith("Symbol store selected", {
			backend: "injected-store",
		});
	});

	it("wraps a Database", () => {
		const db = { query: vi.fn(), transaction: vi.fn() } as unknown as Database;
		const store = createSymbolStore(db);
		expect(store).toBeInstanceOf(SqlSymbolStore);
		expect(SqlSymbolStore.fromDatabase).toHaveBeenCalledWith(db);
		expect(mocks.info).toHaveBeenCalledWith("Symbol store selected", {
			backend: "injected-database",
		});
	});

	it("treats a plain path as a SQLite file and libsql:// as given", () => {
		createSymbolStore("/tmp/x.sqlite");
		expect(SqlSymbolStore.fromConfig).toHaveBeenLastCalledWith({
			dialect: "sqlite",
			url: "file:/tmp/x.sqlite",
			mode: "stateful",
		});
		createSymbolStore("libsql://h.example.io");
		expect(SqlSymbolStore.fromConfig).toHaveBeenLastCalledWith({
			dialect: "sqlite",
			url: "libsql://h.example.io",
			mode: "stateful",
		});
	});

	it("maps {dbUrl, dbToken} to a Turso store", () => {
		createSymbolStore({ dbUrl: "libsql://t.example.io", dbToken: "SECRET" });
		expect(SqlSymbolStore.fromConfig).toHaveBeenCalledWith({
			dialect: "sqlite",
			url: "libsql://t.example.io",
			authToken: "SECRET",
			mode: "stateful",
		});
	});

	it("beats config: a mongodb store config does not matter when an argument is given", () => {
		config["markets.nasdaq.symbols.store"] = "mongodb";
		createSymbolStore("/tmp/y.sqlite");
		expect(SqlSymbolStore.fromConfig).toHaveBeenCalled();
	});

	it.each([
		"mongodb://u:pw@h1:27017/db",
		"mongodb+srv://u:pw@h.example.net/db",
	])("picks Mongo for %s without connecting and logs only the host", (uri) => {
		const store = createSymbolStore(uri);
		expect(store).toBeInstanceOf(MongoSymbolStore);
		const [, extras] = mocks.info.mock.calls[0] as [
			string,
			Record<string, string>,
		];
		expect(extras.backend).toBe("mongodb");
		expect(JSON.stringify(mocks.info.mock.calls)).not.toContain("pw");
		expect(JSON.stringify(mocks.info.mock.calls)).not.toContain("/db");
	});

	it("matches the scheme case-insensitively", () => {
		expect(createSymbolStore("MongoDB://h:1/db")).toBeInstanceOf(
			MongoSymbolStore,
		);
	});

	it("logs a comma-joined host list for a multi-host URI", () => {
		createSymbolStore("mongodb://u:pw@a:1,b:2/db?replicaSet=r&x=secret");
		expect(mocks.info).toHaveBeenCalledWith("Symbol store selected", {
			backend: "mongodb",
			host: "a:1,b:2",
		});
	});

	it("rejects a mongodb:// string on Cloudflare", () => {
		mocks.detectRuntime.mockReturnValue("cloudflare");
		expect(() => createSymbolStore("mongodb://h/db")).toThrow(
			/not supported on Cloudflare Workers.*Turso/s,
		);
	});
});

describe("createSymbolStore from config", () => {
	it("defaults to the SQLite temp file when nothing is configured", () => {
		createSymbolStore(undefined);
		expect(SqlSymbolStore.fromConfig).toHaveBeenCalledWith({
			dialect: "sqlite",
			url: `file:${getTempDir()}/NasdaqSymbols.sqlite`,
			mode: "stateful",
		});
		expect(mocks.info).toHaveBeenCalledWith("Symbol store selected", {
			backend: "sqlite",
		});
	});

	it("store=sqlite builds the SQLite temp file", () => {
		config["markets.nasdaq.symbols.store"] = "sqlite";
		createSymbolStore(undefined);
		expect(SqlSymbolStore.fromConfig).toHaveBeenCalledWith({
			dialect: "sqlite",
			url: `file:${getTempDir()}/NasdaqSymbols.sqlite`,
			mode: "stateful",
		});
	});

	it("store=turso reads the named env vars, defaults included, and logs host only", () => {
		config["markets.nasdaq.symbols.store"] = "turso";
		env.CORELIB_TURSO_URL = "libsql://db-org.turso.io";
		env.CORELIB_TURSO_TOKEN = "TOKEN123";
		createSymbolStore(undefined);
		expect(SqlSymbolStore.fromConfig).toHaveBeenCalledWith({
			dialect: "sqlite",
			url: "libsql://db-org.turso.io",
			authToken: "TOKEN123",
			mode: "stateful",
		});
		expect(mocks.info).toHaveBeenCalledWith("Symbol store selected", {
			backend: "turso",
			host: "db-org.turso.io",
		});
		expect(JSON.stringify(mocks.info.mock.calls)).not.toContain("TOKEN123");
	});

	it("store=turso honours configured variable names", () => {
		config["markets.nasdaq.symbols.store"] = "turso";
		config["markets.nasdaq.symbols.turso"] = {
			urlEnv: "MY_URL",
			tokenEnv: "MY_TOK",
		};
		config["markets.nasdaq.symbols.turso.urlEnv"] = "MY_URL";
		config["markets.nasdaq.symbols.turso.tokenEnv"] = "MY_TOK";
		env.MY_URL = "libsql://x.turso.io";
		env.MY_TOK = "t";
		createSymbolStore(undefined);
		expect(SqlSymbolStore.fromConfig).toHaveBeenCalledWith(
			expect.objectContaining({ url: "libsql://x.turso.io", authToken: "t" }),
		);
	});

	it("store=turso with a missing URL names the variable and the setting", () => {
		config["markets.nasdaq.symbols.store"] = "turso";
		expect(() => createSymbolStore(undefined)).toThrow(
			/CORELIB_TURSO_URL.*markets\.nasdaq\.symbols\.store/s,
		);
	});

	it("store=turso with a missing token names the variable and the setting", () => {
		config["markets.nasdaq.symbols.store"] = "turso";
		env.CORELIB_TURSO_URL = "libsql://x.turso.io";
		env.CORELIB_TURSO_TOKEN = "";
		expect(() => createSymbolStore(undefined)).toThrow(
			/CORELIB_TURSO_TOKEN.*markets\.nasdaq\.symbols\.store/s,
		);
	});

	it("store=mongodb builds a MongoSymbolStore from the named variable", () => {
		config["markets.nasdaq.symbols.store"] = "mongodb";
		env.MONGODB_URI =
			"mongodb+srv://u:pw@cluster.example.net/?retryWrites=true";
		const store = createSymbolStore(undefined);
		expect(store).toBeInstanceOf(MongoSymbolStore);
		expect(mocks.info).toHaveBeenCalledWith("Symbol store selected", {
			backend: "mongodb",
			host: "cluster.example.net",
		});
		expect(JSON.stringify(mocks.info.mock.calls)).not.toContain("pw");
	});

	it("store=mongodb with MONGODB_URI unset names the variable and the setting", () => {
		config["markets.nasdaq.symbols.store"] = "mongodb";
		expect(() => createSymbolStore(undefined)).toThrow(
			/MONGODB_URI.*markets\.nasdaq\.symbols\.store/s,
		);
	});

	it("store=mongodb on Cloudflare throws before reading the URI", () => {
		config["markets.nasdaq.symbols.store"] = "mongodb";
		env.MONGODB_URI = "mongodb://h/db";
		mocks.detectRuntime.mockReturnValue("cloudflare");
		expect(() => createSymbolStore(undefined)).toThrow(
			/not supported on Cloudflare Workers.*Turso/s,
		);
	});

	it("an unknown store value lists the valid values and names the key", () => {
		config["markets.nasdaq.symbols.store"] = "postgres";
		expect(() => createSymbolStore(undefined)).toThrow(
			/markets\.nasdaq\.symbols\.store.*"sqlite".*"turso".*"mongodb"|sqlite.*turso.*mongodb/s,
		);
		expect(() => createSymbolStore(undefined)).toThrow(/postgres/);
	});
});

describe("credential safety of the logged host", () => {
	it.each([
		"mongodb://u:pa/ss@h1/db",
		"mongodb://u:pa?ss@h1",
		"mongodb://u:pa#ss@h1",
	])("never logs a fragment of the credentials for %s", (uri) => {
		createSymbolStore(uri);
		const logged = JSON.stringify(mocks.info.mock.calls);
		expect(logged).not.toContain("pa");
		expect(logged).not.toContain("ss");
		expect(logged).not.toContain("u:");
	});

	it("still logs the hosts of a multi-host URI with an escaped password", () => {
		createSymbolStore("mongodb://u:p%2Fw@h1:27017,h2:27017/db");
		expect(mocks.info).toHaveBeenCalledWith("Symbol store selected", {
			backend: "mongodb",
			host: "h1:27017,h2:27017",
		});
	});

	it("logs the host of an srv URI", () => {
		createSymbolStore("mongodb+srv://u:p@cluster.example.net/db");
		expect(mocks.info).toHaveBeenCalledWith("Symbol store selected", {
			backend: "mongodb",
			host: "cluster.example.net",
		});
	});

	it("omits host when the host part is not a plain host list", () => {
		createSymbolStore("mongodb://u:p@h 1/db");
		expect(mocks.info).toHaveBeenCalledWith("Symbol store selected", {
			backend: "mongodb",
		});
	});
});

describe("null and config passthrough", () => {
	it("treats null like no argument", () => {
		createSymbolStore(null as unknown as undefined);
		expect(SqlSymbolStore.fromConfig).toHaveBeenCalledWith({
			dialect: "sqlite",
			url: `file:${getTempDir()}/NasdaqSymbols.sqlite`,
			mode: "stateful",
		});
	});

	it("passes the configured database and collection to MongoSymbolStore (config form)", () => {
		config["markets.nasdaq.symbols.store"] = "mongodb";
		config["markets.nasdaq.symbols.mongodb.database"] = "dbX";
		config["markets.nasdaq.symbols.mongodb.collection"] = "colY";
		env.MONGODB_URI = "mongodb://h1/";
		createSymbolStore(undefined);
		expect(mocks.mongoCtor).toHaveBeenCalledWith({
			uri: "mongodb://h1/",
			defaultDatabase: "dbX",
			collection: "colY",
		});
	});

	it("passes the configured database and collection to MongoSymbolStore (string form)", () => {
		config["markets.nasdaq.symbols.mongodb.database"] = "dbX";
		config["markets.nasdaq.symbols.mongodb.collection"] = "colY";
		createSymbolStore("mongodb://h1/");
		expect(mocks.mongoCtor).toHaveBeenCalledWith({
			uri: "mongodb://h1/",
			defaultDatabase: "dbX",
			collection: "colY",
		});
	});
});
