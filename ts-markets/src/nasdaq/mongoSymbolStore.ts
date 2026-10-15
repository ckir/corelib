// =============================================
// FILE: ts-markets/src/nasdaq/mongoSymbolStore.ts
// PURPOSE: SymbolStore backed by MongoDB. Atomic refresh without transactions: rows are tagged with a
// generation number and one forward-only update of the metadata document makes a generation visible.
// =============================================

import { logger as baseLogger, detectRuntime } from "@ckirg/corelib";
import type {
	Collection,
	Document,
	MongoClient,
	MongoClientOptions,
} from "mongodb";
import { serializeError } from "serialize-error";
import type { MarketSymbolRow } from "./MarketSymbols";
import { type SymbolStore, SymbolStoreUnavailableError } from "./symbolStore";

const log = baseLogger.child({ section: "MongoSymbolStore" });

export interface MongoSymbolStoreOptions {
	uri: string;
	/** Explicit database override (tests). */
	database?: string;
	/** Config default, used when neither the override nor the URI path names a database. */
	defaultDatabase?: string;
	/** Collection name, default "nasdaq_symbols". */
	collection?: string;
	/** Test-only seam, awaited between the inserts and the flip. */
	onBeforeFlip?: () => Promise<void>;
}

const DEFAULT_COLLECTION = "nasdaq_symbols";
const DEFAULT_DATABASE = "corelib";
const META_ID = "meta";
const INSERT_BATCH = 1000;
const GEN_CACHE_TTL_MS = 5000;

type MongoModule = typeof import("mongodb");

// One shared import: a concurrent first import() of a mocked module can resolve to the real one.
let driverModule: Promise<MongoModule> | undefined;
const loadDriver = (): Promise<MongoModule> =>
	(driverModule ??= import("mongodb"));

/**
 * Picks the database name: explicit wins, then the database in the URI path, then `fallback`.
 * Parsed by hand because client.db() with no argument silently yields "test" for a URI without a path.
 */
export function resolveDatabaseName(
	uri: string,
	explicit: string | undefined,
	fallback: string,
): string {
	if (explicit !== undefined && explicit !== "") {
		return explicit;
	}
	const schemeEnd = uri.indexOf("://");
	let rest = schemeEnd >= 0 ? uri.slice(schemeEnd + 3) : uri;
	const query = rest.indexOf("?");
	if (query >= 0) {
		rest = rest.slice(0, query);
	}
	const slash = rest.indexOf("/");
	if (slash < 0) {
		return fallback;
	}
	const path = rest.slice(slash + 1);
	if (path === "") {
		return fallback;
	}
	try {
		return decodeURIComponent(path);
	} catch {
		return path;
	}
}

// ---- client registry ----------------------------------------------------------------------

interface RegistryEntry {
	promise: Promise<MongoClient>;
	refs: number;
}

const registry = new Map<string, RegistryEntry>();

/** Test seam: number of live shared clients. */
export function __clientRegistrySize(): number {
	return registry.size;
}

function clientOptions(): MongoClientOptions {
	if (detectRuntime() === "aws-lambda") {
		return {
			maxPoolSize: 2,
			serverSelectionTimeoutMS: 5000,
			connectTimeoutMS: 5000,
		};
	}
	return {};
}

async function connectClient(uri: string): Promise<MongoClient> {
	const { MongoClient: Client } = await loadDriver();
	const client = new Client(uri, clientOptions());
	try {
		await client.connect();
	} catch (e) {
		await client.close().catch(() => undefined);
		throw e;
	}
	return client;
}

/** Takes a reference (before awaiting, so concurrent callers share one client). */
async function acquireClient(uri: string): Promise<MongoClient> {
	let entry = registry.get(uri);
	if (!entry) {
		const created: RegistryEntry = {
			promise: connectClient(uri),
			refs: 0,
		};
		entry = created;
		registry.set(uri, created);
		// A failed connect must not stay registered (retry possible).
		created.promise.catch(() => {
			if (registry.get(uri) === created) {
				registry.delete(uri);
			}
		});
	}
	entry.refs++;
	try {
		return await entry.promise;
	} catch (e) {
		entry.refs--;
		throw e;
	}
}

async function releaseClient(uri: string): Promise<void> {
	const entry = registry.get(uri);
	if (!entry) {
		return;
	}
	entry.refs--;
	if (entry.refs > 0) {
		return;
	}
	registry.delete(uri);
	try {
		const client = await entry.promise;
		await client.close();
	} catch (e) {
		log.warn("closing the MongoDB client failed", { error: serializeError(e) });
	}
}

// ---- error mapping ------------------------------------------------------------------------

function isConnectionError(
	mod: MongoModule,
	e: unknown,
	atConnect: boolean,
): boolean {
	if (
		e instanceof mod.MongoServerSelectionError ||
		e instanceof mod.MongoNetworkError
	) {
		return true;
	}
	if (atConnect && e instanceof mod.MongoServerError) {
		return e.code === 18 || e.codeName === "AuthenticationFailed";
	}
	return false;
}

function isDuplicateKey(e: unknown): boolean {
	return (
		typeof e === "object" &&
		e !== null &&
		(e as { code?: unknown }).code === 11000
	);
}

// ---- the store ----------------------------------------------------------------------------

export class MongoSymbolStore implements SymbolStore {
	private readonly uri: string;
	private readonly dbName: string;
	private readonly collectionName: string;
	private readonly onBeforeFlip: (() => Promise<void>) | undefined;
	private initPromise: Promise<void> | null = null;
	private mod: MongoModule | null = null;
	private col: Collection<Document> | null = null;
	private genCache: { gen: number; at: number } | null = null;

	constructor(options: MongoSymbolStoreOptions) {
		this.uri = options.uri;
		this.dbName = resolveDatabaseName(
			options.uri,
			options.database,
			options.defaultDatabase ?? DEFAULT_DATABASE,
		);
		this.collectionName = options.collection ?? DEFAULT_COLLECTION;
		this.onBeforeFlip = options.onBeforeFlip;
	}

	init(): Promise<void> {
		this.initPromise ??= this.doInit().catch((e) => {
			this.initPromise = null;
			throw e;
		});
		return this.initPromise;
	}

	private async doInit(): Promise<void> {
		const mod = await loadDriver();
		let referenced = false;
		try {
			const client = await acquireClient(this.uri);
			referenced = true;
			const col = client.db(this.dbName).collection(this.collectionName);
			await col.createIndex({ symbol: 1, gen: 1 }, { unique: true });
			await col.createIndex({ gen: 1 });
			try {
				await col.updateOne(
					{ _id: META_ID as never },
					{
						$setOnInsert: { nextGen: 0, currentGen: 0, lastRefreshTs: 0 },
					},
					{ upsert: true },
				);
			} catch (e) {
				// Two stores racing on a fresh database: the other one won, which is fine.
				if (!isDuplicateKey(e)) {
					throw e;
				}
			}
			this.mod = mod;
			this.col = col;
			log.debug("MongoDB symbol store ready", {
				database: this.dbName,
				collection: this.collectionName,
			});
		} catch (e) {
			if (referenced) {
				await releaseClient(this.uri);
			}
			throw this.mapError(mod, e, true);
		}
	}

	private mapError(mod: MongoModule, e: unknown, atConnect: boolean): unknown {
		if (e instanceof SymbolStoreUnavailableError) {
			return e;
		}
		if (isConnectionError(mod, e, atConnect)) {
			return new SymbolStoreUnavailableError(
				"MongoDB symbol store is unavailable",
				{
					cause: e,
				},
			);
		}
		return e;
	}

	private async run<T>(
		fn: (col: Collection<Document>) => Promise<T>,
	): Promise<T> {
		await this.init();
		const col = this.col;
		const mod = this.mod;
		if (!col || !mod) {
			throw new Error("MongoSymbolStore is closed");
		}
		try {
			return await fn(col);
		} catch (e) {
			throw this.mapError(mod, e, false);
		}
	}

	private async readCurrentGen(col: Collection<Document>): Promise<number> {
		const meta = await col.findOne(
			{ _id: META_ID as never },
			{ projection: { currentGen: 1 } },
		);
		const gen = typeof meta?.currentGen === "number" ? meta.currentGen : 0;
		this.genCache = { gen, at: Date.now() };
		return gen;
	}

	find(symbol: string): Promise<MarketSymbolRow | null> {
		return this.run(async (col) => {
			if (typeof symbol !== "string" || symbol === "") {
				return null;
			}
			const wanted = symbol.toUpperCase();
			const now = Date.now();
			const cache = this.genCache;
			const cacheFresh =
				cache !== null && now >= cache.at && now - cache.at < GEN_CACHE_TTL_MS;
			let gen = cacheFresh ? cache.gen : await this.readCurrentGen(col);
			let doc = gen > 0 ? await col.findOne({ symbol: wanted, gen }) : null;
			if (!doc && cacheFresh) {
				const fresh = await this.readCurrentGen(col);
				if (fresh !== gen) {
					gen = fresh;
					doc = gen > 0 ? await col.findOne({ symbol: wanted, gen }) : null;
				}
			}
			return doc ? toRow(doc) : null;
		});
	}

	lastRefreshTs(): Promise<number | null> {
		return this.run(async (col) => {
			const meta = await col.findOne({ _id: META_ID as never });
			if (
				!meta ||
				typeof meta.currentGen !== "number" ||
				meta.currentGen <= 0 ||
				typeof meta.lastRefreshTs !== "number"
			) {
				return null;
			}
			return meta.lastRefreshTs;
		});
	}

	count(): Promise<number> {
		return this.run(async (col) => {
			const gen = await this.readCurrentGen(col);
			return gen > 0 ? col.countDocuments({ gen }) : 0;
		});
	}

	replaceAll(rows: MarketSymbolRow[], refreshTs: number): Promise<void> {
		return this.run(async (col) => {
			if (rows.length === 0) {
				throw new Error(
					"MongoSymbolStore.replaceAll: refusing an empty row set",
				);
			}
			// 1. take a generation
			const myGen = await this.takeGeneration(col);
			// 2. insert everything, tagged with the generation
			try {
				for (let i = 0; i < rows.length; i += INSERT_BATCH) {
					const batch = rows.slice(i, i + INSERT_BATCH).map((r) => ({
						symbol: r.symbol.toUpperCase(),
						type: r.type,
						class: r.class,
						name: r.name,
						ts: Number(r.ts),
						gen: myGen,
					}));
					await col.insertMany(batch, { ordered: false });
				}
			} catch (e) {
				await this.deleteGeneration(col, myGen);
				throw e;
			}
			await this.onBeforeFlip?.();
			// 3. flip forward only
			const flip = await col.updateOne(
				{ _id: META_ID as never, currentGen: { $lt: myGen } },
				{ $set: { currentGen: myGen, lastRefreshTs: refreshTs } },
			);
			if (flip.matchedCount === 0) {
				// A newer refresh already won; discard our rows.
				await this.deleteGeneration(col, myGen);
				return;
			}
			this.genCache = { gen: myGen, at: Date.now() };
			// 4. prune, keeping the previous generation for in-flight reads
			try {
				await col.deleteMany({
					_id: { $ne: META_ID as never },
					gen: { $type: "number", $lt: myGen - 1 },
				});
			} catch (e) {
				log.warn("pruning old symbol generations failed", {
					error: serializeError(e),
				});
			}
		});
	}

	private async takeGeneration(col: Collection<Document>): Promise<number> {
		const take = () =>
			col.findOneAndUpdate(
				{ _id: META_ID as never },
				{
					$inc: { nextGen: 1 },
					$setOnInsert: { currentGen: 0, lastRefreshTs: 0 },
				},
				{ upsert: true, returnDocument: "after" },
			);
		let meta: Document | null;
		try {
			meta = await take();
		} catch (e) {
			if (!isDuplicateKey(e)) {
				throw e;
			}
			meta = await take();
		}
		if (typeof meta?.nextGen !== "number") {
			throw new Error("MongoSymbolStore: metadata document has no nextGen");
		}
		return meta.nextGen;
	}

	private async deleteGeneration(
		col: Collection<Document>,
		gen: number,
	): Promise<void> {
		try {
			await col.deleteMany({ _id: { $ne: META_ID as never }, gen });
		} catch (e) {
			log.warn("deleting an abandoned symbol generation failed", {
				error: serializeError(e),
			});
		}
	}

	async close(): Promise<void> {
		const pending = this.initPromise;
		if (!pending) {
			return;
		}
		await pending.catch(() => undefined);
		if (this.col === null) {
			return;
		}
		this.col = null;
		this.mod = null;
		this.genCache = null;
		this.initPromise = null;
		await releaseClient(this.uri);
	}
}

function toRow(doc: Document): MarketSymbolRow {
	return {
		symbol: String(doc.symbol),
		name: String(doc.name),
		type: doc.type === "eod" ? "eod" : "rt",
		class: String(doc.class),
		ts: Number(doc.ts),
		active: true,
	};
}
