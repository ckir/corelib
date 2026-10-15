// =============================================
// FILE: ts-markets/src/nasdaq/symbolStoreFactory.ts
// PURPOSE: Chooses the SymbolStore for MarketSymbols: an explicit constructor argument always wins,
// otherwise the `markets.nasdaq.symbols.store` setting (sqlite | turso | mongodb) decides.
// =============================================

import {
	logger as baseLogger,
	ConfigManager,
	type Database,
	detectRuntime,
	getEnv,
	getTempDir,
} from "@ckirg/corelib";
import { MongoSymbolStore } from "./mongoSymbolStore";
import { SqlSymbolStore } from "./sqlSymbolStore";
import type { SymbolStore } from "./symbolStore";

const marketSymbolsLogger = baseLogger.child({ section: "MarketSymbols" });

const STORE_KEY = "markets.nasdaq.symbols.store";
const VALID_STORES = ["sqlite", "turso", "mongodb"] as const;

const DEFAULT_TURSO_URL_ENV = "CORELIB_TURSO_URL";
const DEFAULT_TURSO_TOKEN_ENV = "CORELIB_TURSO_TOKEN";
const DEFAULT_MONGODB_URI_ENV = "MONGODB_URI";
const DEFAULT_MONGODB_DATABASE = "corelib";
const DEFAULT_MONGODB_COLLECTION = "nasdaq_symbols";

type StoreArg =
	| string
	| { dbUrl: string; dbToken: string }
	| Database
	| SymbolStore
	| undefined;

type Backend =
	| "sqlite"
	| "turso"
	| "mongodb"
	| "injected-database"
	| "injected-store";

function isSymbolStore(arg: unknown): arg is SymbolStore {
	return (
		typeof arg === "object" &&
		arg !== null &&
		typeof (arg as { replaceAll?: unknown }).replaceAll === "function"
	);
}

function isDatabase(arg: unknown): arg is Database {
	return (
		typeof arg === "object" &&
		arg !== null &&
		"query" in arg &&
		typeof (arg as { query?: unknown }).query === "function"
	);
}

const isMongoUri = (s: string): boolean => /^mongodb(\+srv)?:\/\//i.test(s);

/** Reads a string setting, falling back to its default when absent or not a non-empty string. */
function configString(path: string, fallback: string): string {
	const v = ConfigManager.get(path);
	return typeof v === "string" && v !== "" ? v : fallback;
}

/**
 * Host(s) of a connection URL; never the credentials, path, query string or token. Anything that is not
 * a plain host list yields no host at all (never a best-effort fragment).
 */
function hostsOf(url: string): string | undefined {
	const schemeEnd = url.indexOf("://");
	const rest = schemeEnd >= 0 ? url.slice(schemeEnd + 3) : url;
	const cut = rest.search(/[/?#]/);
	const authority = cut < 0 ? rest : rest.slice(0, cut);
	// An "@" after the authority (path, query, fragment) means the URL is not in a shape we can trust.
	if (cut >= 0 && rest.slice(cut).includes("@")) return undefined;
	const hosts = authority.slice(authority.lastIndexOf("@") + 1);
	return /^[A-Za-z0-9._\-[\]:,]+$/.test(hosts) ? hosts : undefined;
}

function logSelected(backend: Backend, url?: string): void {
	const host = url === undefined ? undefined : hostsOf(url);
	marketSymbolsLogger.info(
		"Symbol store selected",
		host === undefined ? { backend } : { backend, host },
	);
}

function requireEnv(envName: string): string {
	const value = getEnv(envName);
	if (value === undefined || value === "") {
		throw new Error(
			`Environment variable ${envName} is empty or not set, but ${STORE_KEY} selects a store that needs it.`,
		);
	}
	return value;
}

function assertMongoSupported(): void {
	if (detectRuntime() === "cloudflare") {
		throw new Error(
			`MongoDB is not supported on Cloudflare Workers (${STORE_KEY}); use Turso instead.`,
		);
	}
}

function newMongoStore(uri: string): MongoSymbolStore {
	return new MongoSymbolStore({
		uri,
		defaultDatabase: configString(
			"markets.nasdaq.symbols.mongodb.database",
			DEFAULT_MONGODB_DATABASE,
		),
		collection: configString(
			"markets.nasdaq.symbols.mongodb.collection",
			DEFAULT_MONGODB_COLLECTION,
		),
	});
}

function sqliteFile(path: string): SymbolStore {
	return SqlSymbolStore.fromConfig({
		dialect: "sqlite",
		url:
			path.startsWith("libsql://") || path.startsWith("file:")
				? path
				: `file:${path}`,
		mode: "stateful",
	});
}

function fromArgument(arg: Exclude<StoreArg, undefined>): SymbolStore {
	if (isSymbolStore(arg)) {
		logSelected("injected-store");
		return arg;
	}
	if (isDatabase(arg)) {
		const store = SqlSymbolStore.fromDatabase(arg);
		logSelected("injected-database");
		return store;
	}
	if (typeof arg === "string") {
		if (isMongoUri(arg)) {
			assertMongoSupported();
			const store = newMongoStore(arg);
			logSelected("mongodb", arg);
			return store;
		}
		const store = sqliteFile(arg);
		if (arg.startsWith("libsql://")) logSelected("turso", arg);
		else logSelected("sqlite");
		return store;
	}
	const turso = arg as { dbUrl: string; dbToken: string };
	const store = SqlSymbolStore.fromConfig({
		dialect: "sqlite",
		url: turso.dbUrl,
		authToken: turso.dbToken,
		mode: "stateful",
	});
	logSelected("turso", turso.dbUrl);
	return store;
}

function fromConfig(): SymbolStore {
	const configured = ConfigManager.get(STORE_KEY);
	const choice = configured === undefined ? "sqlite" : configured;
	switch (choice) {
		case "sqlite": {
			const store = sqliteFile(`${getTempDir()}/NasdaqSymbols.sqlite`);
			logSelected("sqlite");
			return store;
		}
		case "turso": {
			const url = requireEnv(
				configString(
					"markets.nasdaq.symbols.turso.urlEnv",
					DEFAULT_TURSO_URL_ENV,
				),
			);
			const token = requireEnv(
				configString(
					"markets.nasdaq.symbols.turso.tokenEnv",
					DEFAULT_TURSO_TOKEN_ENV,
				),
			);
			const store = SqlSymbolStore.fromConfig({
				dialect: "sqlite",
				url,
				authToken: token,
				mode: "stateful",
			});
			logSelected("turso", url);
			return store;
		}
		case "mongodb": {
			assertMongoSupported();
			const uri = requireEnv(
				configString(
					"markets.nasdaq.symbols.mongodb.uriEnv",
					DEFAULT_MONGODB_URI_ENV,
				),
			);
			const store = newMongoStore(uri);
			logSelected("mongodb", uri);
			return store;
		}
		default:
			throw new Error(
				`Unknown symbol store ${JSON.stringify(choice)} in ${STORE_KEY}; valid values are ${VALID_STORES.map((v) => `"${v}"`).join(", ")}.`,
			);
	}
}

/**
 * Creates the symbol store. A constructor argument always wins; with none, `markets.nasdaq.symbols.store`
 * decides. No connection is opened here.
 */
export function createSymbolStore(arg: StoreArg): SymbolStore {
	// An empty string was "no argument" before (falsy), so it still means the configured default.
	return arg == null || arg === "" ? fromConfig() : fromArgument(arg);
}
