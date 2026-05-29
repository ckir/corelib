import { EventEmitter } from 'node:events';
import * as serialize_error from 'serialize-error';
import { ErrorObject } from 'serialize-error';
import { S as StrictLogger } from './index-DaxjTY9o.js';
export { L as LogMethod } from './index-DaxjTY9o.js';
import { Options } from 'ky';
import { Cron } from 'croner';

/**
 * ConfigManager handles the lifecycle of the application's configuration.
 * It manages globalThis.sysconfig and provides an event-driven interface
 * for runtime updates.
 * * Priority: CLI > Environment Variables > Config Files > Defaults
 */
declare class ConfigManager extends EventEmitter {
    private static instance;
    private _config;
    private _defaultsPath;
    private static _logger;
    private constructor();
    /**
     * Singleton accessor for the ConfigManager
     */
    static getInstance(): ConfigManager;
    /**
     * Retrieves a nested configuration value by string path (e.g., "db.mysql.port").
     * @param {string} path - The dot-notation path to the configuration value.
     * @returns The value at the specified path, or undefined if not found.
     */
    get(path: string): unknown;
    /**
     * Static helper to retrieve a configuration value from the singleton instance.
     */
    static get(path: string): unknown;
    /**
     * Main initialization sequence.
     * 1. Load Defaults
     * 2. Detect CLI -C flag for external config
     * 3. Process Hierarchy (commonAll -> app -> platform -> mode)
     * 4. Apply Env Overrides
     * 5. Apply CLI Overrides
     */
    initialize(): Promise<void>;
    /**
     * Retrieves the current active configuration object.
     */
    getConfig(): Record<string, unknown>;
    /**
     * Public method to load and merge a new configuration from a URL or file path on demand.
     * Respects the established configuration hierarchy and maintains Env overrides.
     * @param source - The URL or local file path to the configuration.
     */
    loadExternalConfig(source: string): Promise<void>;
    /**
     * Loads the base ConfigManager.json from the local directory.
     * Always seeds from the bundled JSON (available in all runtimes, including edge).
     * If the JSON file is also found on disk, it replaces the bundled defaults.
     */
    private loadDefaults;
    /**
     * Fetches and parses configuration from a URL or Local Path.
     * Supports .enc decryption and dynamic confbox parsing by extension.
     */
    private fetchExternalConfig;
    private validateConfigObject;
    /**
     * Processes the specific hierarchy:
     * commonAll -> [AppName].common -> [AppName].[platform] -> [AppName].[platform].[mode]
     */
    private processHierarchy;
    /**
     * Maps CORELIB_ prefixed environment variables to config keys.
     * Example: CORELIB_DB_PORT -> config.db.port
     */
    private applyEnvOverrides;
    /**
     * Maps Kebab-case CLI arguments to the config structure.
     */
    private applyCliOverrides;
    /**
     * Core update method that updates both the local object
     * and the active globalThis object, then emits events.
     */
    updateValue(path: string, value: unknown): void;
    /**
     * Helper to set nested object values by string path (e.g., "db.mysql.port")
     */
    private setPath;
    /**
     * Parses values from Env/CLI, automatically handling JSON strings for arrays/objects.
     */
    private parseValue;
    private getAppName;
    /**
     * Logs errors internally. If the global pino logger is available, it uses it
     * along with `serialize-error` to structure the error object for Vector sidecars.
     */
    private logError;
    toJsonString(): string;
    toBuffer(): Buffer;
}

/**
 * Raw FFI exports from the native binary.
 * Use with caution and proper type casting.
 */
declare const coreFFI: any;
/**
 * Checks if the native FFI library is loaded and available.
 * @returns {boolean} True if FFI is available, false otherwise.
 */
declare function isFfiAvailable(): boolean;
/**
 * Native FFI function: Logs a message from Rust and returns the doubled value.
 * @param {string} msg - The message to log.
 * @param {number} value - The number to double.
 * @returns {number} The doubled value returned from Rust.
 * @throws {Error} If FFI is not loaded or incompatible.
 */
declare function logAndDouble(msg: string, value: number): number;
/**
 * Native FFI function: Gets the version of the native library.
 * @returns {string} The version string from Rust.
 * @throws {Error} If FFI is not loaded or incompatible.
 */
declare function getVersion(): string;
/**
 * Core section containing FFI and basic runtime information.
 */
declare const Core: {
    /**
     * Checks if FFI is available.
     */
    isFfiAvailable: typeof isFfiAvailable;
    /**
     * Gets the native library version.
     */
    getVersion: typeof getVersion;
    /**
     * Calls the native log and double function.
     */
    logAndDouble: typeof logAndDouble;
    /**
     * Runs a core task or simply logs the current runtime status.
     * @param {string} [task] - Optional task name to log.
     * @param {Record<string, unknown>} [options] - Optional options for the task.
     */
    run: (task?: string, options?: Record<string, unknown>) => void;
};

/**
 * The standard Result pattern used across the database module to ensure safe error handling.
 * It can be either a success with a value or an error with a reason.
 *
 * @template T The type of the value on success.
 */
type DatabaseResult<T = unknown> = {
    /** Status of the operation. */
    status: "success";
    /** The result value. */
    value: T;
    /** Optional additional details about the operation. */
    details?: unknown;
} | {
    /** Status of the operation. */
    status: "error";
    /** The reason for the failure, either as a serialized error or a simple message. */
    reason: ErrorObject | {
        message: string;
        [key: string]: unknown;
    };
};
/**
 * Wraps a successful value in a DatabaseResult.
 *
 * @template T The type of the value.
 * @param {T} value - The value to wrap.
 * @param {unknown} [details] - Optional additional details.
 * @returns {DatabaseResult<T>} A success DatabaseResult.
 */
declare const wrapSuccess: <T>(value: T, details?: unknown) => DatabaseResult<T>;
/**
 * Wraps an error in a DatabaseResult, serializing it for cross-runtime safety.
 *
 * @template T The expected type of the value (will be unused since this is an error).
 * @param {unknown} error - The error to wrap.
 * @returns {DatabaseResult<T>} An error DatabaseResult.
 */
declare const wrapError: <T = unknown>(error: unknown) => DatabaseResult<T>;

/**
 * Type alias for the library's strict logger.
 */
type LibraryLogger = StrictLogger;
/**
 * Database operation mode.
 * - 'stateless': Connects and disconnects for each operation (suitable for serverless/edge).
 * - 'stateful': Maintains persistent connections (suitable for long-running servers).
 */
type DbMode = "stateless" | "stateful";
/**
 * Base configuration for all database dialects.
 */
interface BaseDbConfig {
    /** Database dialect to use. */
    dialect: "sqlite" | "postgres";
    /** Database URL (e.g., 'file:local.db' for SQLite, 'postgres://user:pass@host/db' for Postgres). */
    url: string;
    /** Operation mode. */
    mode: DbMode;
    /** Logger instance (defaults to global logger.child({ section: 'Database' })). */
    logger?: LibraryLogger;
    /** Query timeout in milliseconds. */
    timeoutMs?: number;
}
/** Parameters for SQL queries (positional or named). */
type QueryParams = unknown[] | Record<string, unknown>;
/** Standard data structure for successful query results. */
interface QueryResponse<T = unknown> {
    /** Array of rows returned by the query. */
    rows: T[];
    /** Number of rows affected by the operation (e.g. on INSERT, UPDATE, DELETE). */
    affectedRows?: number;
    /** Last insert ID (optional for Postgres; use RETURNING clauses). */
    lastInsertId?: string | number | bigint;
}
/**
 * Common interface for high-level Database implementations (SqliteDb, PostgresDb).
 * Provides methods for querying and transaction management.
 */
interface Database {
    /**
     * Executes an SQL query and returns the results.
     * @template T The expected type of the rows.
     * @param {string} sql The SQL query string.
     * @param {QueryParams} [params] Optional query parameters.
     * @returns {Promise<import("./result").DatabaseResult<QueryResponse<T>>>} A promise resolving to the query result.
     */
    query<T = unknown>(sql: string, params?: QueryParams): Promise<DatabaseResult<QueryResponse<T>>>;
    /**
     * Executes a callback within a database transaction.
     * @template T The return type of the callback.
     * @param {() => Promise<import("./result").DatabaseResult<T>>} callback The function to execute within the transaction.
     * @returns {Promise<import("./result").DatabaseResult<T>>} A promise resolving to the result of the callback.
     */
    transaction<T>(callback: () => Promise<DatabaseResult<T>>): Promise<DatabaseResult<T>>;
    /**
     * Disconnects from the database (only useful in 'stateful' mode).
     * @returns {Promise<void>}
     */
    disconnect(): Promise<void>;
}

/**
 * Configuration for SQLite dialect.
 */
interface SqliteConfig extends BaseDbConfig {
    dialect: "sqlite";
    authToken?: string;
    localPath?: string;
    maxConnections?: number;
}

/**
 * Public SqliteDb implementation.
 * Provides high-level API for SQLite/LibSQL, handling connections, transactions, and result normalization.
 */
declare class SqliteDb {
    private config;
    private driver;
    constructor(config: SqliteConfig);
    /**
     * Executes a single SQL query.
     * Joins active transaction if called within a transaction block.
     */
    query<T = unknown>(sql: string, params?: QueryParams): Promise<DatabaseResult<QueryResponse<T>>>;
    /**
     * Disconnects from the database.
     */
    disconnect(): Promise<void>;
    /**
     * Executes operations within a transaction using AsyncLocalStorage for context.
     */
    transaction<T>(callback: () => Promise<DatabaseResult<T>>): Promise<DatabaseResult<T>>;
}

/**
 * Interface for prepared statements in the driver.
 * Prepared statements are pre-compiled SQL queries that can be executed multiple times with different parameters.
 */
interface PreparedDriverStatement {
    /**
     * Executes the prepared statement with the given parameters.
     * @template T The expected type of the rows in the result.
     * @param {QueryParams} [params] Optional parameters for the query.
     * @returns {Promise<DatabaseResult<QueryResponse<T>>>} A promise resolving to the database result.
     */
    execute<T = unknown>(params?: QueryParams): Promise<DatabaseResult<QueryResponse<T>>>;
    /**
     * Closes the prepared statement and releases associated resources.
     * @returns {Promise<void>}
     */
    close(): Promise<void>;
}
/**
 * Core interface for database drivers. All dialect-specific drivers (Postgres, SQLite, etc.) must implement this.
 * This ensures a consistent API for database operations across different storage engines.
 */
interface DbDriver {
    /**
     * Establishes a connection to the database.
     * @returns {Promise<void>}
     */
    connect(): Promise<void>;
    /**
     * Closes the connection to the database.
     * @returns {Promise<void>}
     */
    disconnect(): Promise<void>;
    /**
     * Executes a one-off SQL query.
     * @template T The expected type of the rows in the result.
     * @param {string} sql The SQL query string.
     * @param {QueryParams} [params] Optional parameters for the query.
     * @returns {Promise<DatabaseResult<QueryResponse<T>>>} A promise resolving to the database result.
     */
    query<T = unknown>(sql: string, params?: QueryParams): Promise<DatabaseResult<QueryResponse<T>>>;
    /**
     * Prepares an SQL query for execution.
     * @param {string} sql The SQL query string to prepare.
     * @returns {Promise<DatabaseResult<PreparedDriverStatement>>} A promise resolving to the prepared statement.
     */
    prepare(sql: string): Promise<DatabaseResult<PreparedDriverStatement>>;
    /**
     * Begins a new database transaction.
     * @returns {Promise<void>}
     */
    beginTransaction(): Promise<void>;
    /**
     * Commits the current database transaction.
     * @returns {Promise<void>}
     */
    commitTransaction(): Promise<void>;
    /**
     * Rolls back the current database transaction.
     * @returns {Promise<void>}
     */
    rollbackTransaction(): Promise<void>;
    /**
     * Streams the results of an SQL query row by row.
     * @template T The expected type of each row.
     * @param {string} sql The SQL query string.
     * @param {QueryParams} params Parameters for the query.
     * @param {(row: T) => void} onRow Callback function called for each row.
     * @returns {Promise<DatabaseResult<void>>} A promise that resolves when the stream finishes.
     */
    stream<T = unknown>(sql: string, params: QueryParams, onRow: (row: T) => void): Promise<DatabaseResult<void>>;
}

/**
 * Handles and logs database errors, returning a serialized error object.
 */
declare function handleDbError(logger: LibraryLogger, message: string, error: unknown): serialize_error.ErrorObject;

/**
 * High-performance polyfill/loader for AsyncLocalStorage across runtimes.
 * Node/Bun use node:async_hooks, while Deno uses std/node compatibility.
 */
interface AsyncLocalStorageLike<T> {
    run<R>(store: T, callback: () => R): R;
    getStore(): T | undefined;
}
declare const transactionStorage: AsyncLocalStorageLike<DbDriver> | undefined;
/**
 * Gets the active transaction driver from context.
 */
declare function getActiveTransaction(): DbDriver | undefined;
/**
 * Runs a callback within a transaction context.
 * Internal helper used by DB implementations.
 */
declare function runInTransaction<T>(driver: DbDriver, callback: () => Promise<T>): Promise<T>;

/**
 * Configuration for Postgres dialect.
 */
interface PostgresConfig extends BaseDbConfig {
    dialect: "postgres";
    maxConnections?: number;
    ssl?: boolean | {
        rejectUnauthorized?: boolean;
        ca?: string;
        key?: string;
        cert?: string;
    };
}

/**
 * Public PostgresDb implementation.
 * Provides high-level API for Postgres, handling connections, transactions, and result normalization.
 * Note: For lastInsertId, use RETURNING clauses in your INSERT queries as Postgres does not provide it natively.
 */
declare class PostgresDb {
    private config;
    private driver;
    constructor(config: PostgresConfig);
    /**
     * Executes a single SQL query.
     * Joins active transaction if called within a transaction block.
     */
    query<T = unknown>(sql: string, params?: QueryParams): Promise<DatabaseResult<QueryResponse<T>>>;
    /**
     * Disconnects from the database.
     */
    disconnect(): Promise<void>;
    /**
     * Executes operations within a transaction using AsyncLocalStorage for context.
     */
    transaction<T>(callback: () => Promise<DatabaseResult<T>>): Promise<DatabaseResult<T>>;
}

declare class PostgresDriver implements DbDriver {
    private config;
    private client;
    constructor(config: PostgresConfig);
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    query<T = unknown>(sql: string, params?: QueryParams): Promise<DatabaseResult<QueryResponse<T>>>;
    prepare(sql: string): Promise<DatabaseResult<PreparedDriverStatement>>;
    beginTransaction(): Promise<void>;
    commitTransaction(): Promise<void>;
    rollbackTransaction(): Promise<void>;
    stream<T>(sql: string, params: QueryParams, onRow: (row: T) => void): Promise<DatabaseResult<void>>;
}

declare class SqliteDriver implements DbDriver {
    private config;
    private client;
    constructor(config: SqliteConfig);
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    query<T = unknown>(sql: string, params?: QueryParams): Promise<DatabaseResult<QueryResponse<T>>>;
    prepare(sql: string): Promise<DatabaseResult<PreparedDriverStatement>>;
    beginTransaction(): Promise<void>;
    commitTransaction(): Promise<void>;
    rollbackTransaction(): Promise<void>;
    stream<T>(sql: string, params: QueryParams, onRow: (row: T) => void): Promise<DatabaseResult<void>>;
}

/**
 * @file ts-core/src/database/index.ts
 * @description Main entry point for the database module, exporting factory functions and core components.
 */

/**
 * Factory function to create a database instance based on the configuration.
 * It automatically selects the correct implementation (Postgres or SQLite) based on the `dialect` field.
 *
 * @param {BaseDbConfig} config - The database configuration.
 * @returns {Promise<Database>} A promise resolving to a Database instance.
 */
declare function createDatabase(config: BaseDbConfig): Promise<Database>;
/**
 * Database section containing metadata and core components.
 */
declare const DatabaseSection: {
    /**
     * Current status of the database section.
     */
    status: "active";
    /**
     * Reference to the default Database implementation (SqliteDb).
     */
    Database: typeof SqliteDb;
    /**
     * Factory function to create a database instance.
     */
    createDatabase: typeof createDatabase;
};

declare global {
    var logger: StrictLogger | undefined;
}
declare const _default: StrictLogger;

/**
 * Standardized structure for serialized HTTP responses.
 * @template T - The expected type of the body if parsed as JSON; otherwise falls back to string.
 */
interface SerializedResponse<T = unknown> {
    ok: boolean;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    url: string;
    redirected: boolean;
    type: string;
    body: T | string;
}
/**
 * Serializes a Fetch API Response object into a plain structure.
 * Attempts to parse the body as JSON if the Content-Type indicates it; otherwise, treats as text.
 * Falls back to raw text on JSON parse errors. Logs warnings if body reading fails.
 * @param response - The Response object to serialize (or null/undefined).
 * @returns A Promise resolving to the SerializedResponse or null if no response provided.
 * @template T - The expected type of the body if JSON-parsed.
 */
declare function serializeResponse<T = unknown>(response: Response | null | undefined): Promise<SerializedResponse<T> | null>;
/**
 * @deprecated Use serializeResponse instead.
 */
declare const RequestResponseSerialize: {
    serialize: typeof serializeResponse;
};

/**
 * Discriminated union for request results, ensuring type-safe success/error handling.
 * @template T - The expected response body type.
 */
type RequestResult<T = unknown> =
	| {
			status: "success";
			value: SerializedResponse<T>;
	  }
	| {
			status: "error";
			reason: SerializedResponse<T> | ErrorObject;
	  };
/**
 * Makes an HTTP request to a single URL with resilience features.
 * @param url - The URL or Request object to fetch.
 * @param options - Optional ky configuration to override defaults.
 * @returns A Promise resolving to the RequestResult (success or error).
 * @template T - The expected response body type.
 */
declare function endPoint<T = unknown>(
	url: string | URL | Request,
	options?: Options,
): Promise<RequestResult<T>>;
/**
 * Makes parallel HTTP requests to multiple URLs.
 * @param urls - Array of URLs or Request objects to fetch.
 * @param options - Optional ky configuration to apply to all requests.
 * @returns A Promise resolving to an array of RequestResults (in input order).
 * @template T - The expected response body type for each request.
 */
declare function endPoints<T = unknown>(
	urls: (string | URL | Request)[],
	options?: Options,
): Promise<RequestResult<T>[]>;
/**
 * @deprecated Use endPoint/endPoints functions directly.
 */
declare const RequestUnlimited: {
	defaults: Options;
	endPoint: typeof endPoint;
	endPoints: typeof endPoints;
};

/**
 * Proxied HTTP client with automatic rotation, fallback, and load-balancing.
 *
 * Public API is identical to RequestUnlimited (same return types, same Options merging, same discriminated union).
 * All heavy lifting (retries, serialization, logging, error handling) is delegated to RequestUnlimited.
 */
declare class RequestProxied {
    private activeProxies;
    private failureStreaks;
    private currentIndex;
    /**
     * @param proxies - Array of proxy base URLs (e.g. ["https://proxy1...", "https://proxy2..."]).
     *                  At least one proxy is required. The array is cloned internally.
     * @throws Error if no proxies are provided.
     */
    constructor(proxies: string[]);
    /**
     * Builds the final proxy URL using the URL constructor.
     * Guarantees correct query string handling (? vs &) and URL encoding of the original target.
     */
    private buildProxyUrl;
    /**
     * Records a successful request for a proxy (resets failure streak).
     */
    private trackSuccess;
    /**
     * Records a failure for a proxy.
     * After 3 consecutive failures the proxy is permanently removed from the active list for this session.
     */
    private trackFailure;
    /**
     * Makes a single proxied HTTP request with full fallback.
     *
     * @param url - Original target URL (same as RequestUnlimited).
     * @param suffix - Optional path to append to the proxy base (default "").
     * @param options - Ky options passed through to RequestUnlimited (headers, method, body, etc.).
     */
    endPoint<T = unknown>(url: string | URL | Request, suffix?: string, options?: Options): Promise<RequestResult<T>>;
    /**
     * Makes parallel proxied requests with explicit round-robin load balancing.
     *
     * Each original URL is assigned to a proxy via round-robin.
     * The constructed proxy URLs are then passed to RequestUnlimited.endPoints (parallelism + retries handled there).
     *
     * Note: failure tracking / auto-removal is currently only implemented for endPoint().
     *       endPoints uses the current activeProxies snapshot at call time.
     *
     * @param urls - Array of original target URLs.
     * @param suffix - Optional suffix applied to every proxy (default "").
     * @param options - Ky options applied to all requests.
     */
    endPoints<T = unknown>(urls: (string | URL | Request)[], suffix?: string, options?: Options): Promise<RequestResult<T>[]>;
}

declare const Retrieve: {
    run: () => void;
};

/**
 * Run a handler when ANY include cron matches AND
 * NONE of the exclude crons match.
 *
 * Supports 6-field cron expressions (seconds).
 *
 * @param timezone - Optional IANA timezone name (e.g. "America/New_York").
 *   Pattern matching uses the wall-clock time in that zone.
 *   Defaults to the local system timezone when omitted.
 */
declare function includeExcludeCron(includeExprs: string[], excludeExprs: string[], handler: () => void, timezone?: string): Cron<undefined>;

/**
 * Supported runtimes for the core library.
 */
type Runtime = "node" | "bun" | "deno" | "cloudflare" | "aws-lambda" | "gcp-cloudrun";
/**
 * Detects the current execution environment.
 * Uses various global signals and environment variables to distinguish between Node.js, Bun, Deno,
 * and different cloud platforms like Cloudflare Workers, AWS Lambda, and Google Cloud Run.
 *
 * @returns {Runtime} The detected runtime identifier. Defaults to 'node' if unable to determine.
 */
declare function detectRuntime(): Runtime;

/**
 * Main entry point for collecting system telemetry.
 * Automatically detects the runtime and gathers relevant system, process, and environment information.
 *
 * @returns {object} Comprehensive system information.
 */
declare function getSysInfo(): {
    /** Current runtime name. */
    runtime: "node" | "bun";
    /** Operating system platform. */
    os: NodeJS.Platform;
    /** System architecture. */
    arch: NodeJS.Architecture;
    /** Process ID. */
    pid: number;
    /** Parent process ID. */
    ppid: number;
    /** Current working directory. */
    cwd: string;
    /** Process uptime in seconds. */
    uptime: number;
    /** Operating system version/release. */
    osVersion: any;
    /** System load averages for 1, 5, and 15 minutes. */
    loadAvg: any;
    /** Memory usage statistics. */
    memory: {
        /** Resident Set Size. */
        rss: number;
        /** Total heap size. */
        heapTotal: number;
        /** Used heap size. */
        heapUsed: number;
        /** Memory used by C++ objects bound to JavaScript objects. */
        external: number;
    };
    /** Redacted environment variables. */
    env: Record<string, string>;
} | {
    runtime: string;
    os: any;
    arch: any;
    pid: any;
    ppid: any;
    cwd: any;
    uptime: number;
    osVersion: any;
    loadAvg: any;
    memory: {
        rss: any;
        heapTotal: null;
        heapUsed: null;
        external: null;
    };
    env: Record<string, string>;
} | {
    runtime: string;
    os: string;
    arch: string;
    pid: null;
    ppid: null;
    cwd: string;
    uptime: number;
    osVersion: null;
    loadAvg: number[];
    memory: {
        rss: null;
        heapTotal: null;
        heapUsed: null;
        external: null;
    };
    env: {};
};
/**
 * @deprecated Use getSysInfo or detectRuntime instead.
 */
declare const SysInfo: {
    /**
     * Gets system information.
     */
    get: typeof getSysInfo;
};

/**
 * Gets a `require` function suitable for the current runtime.
 * In Node-like runtimes, it uses `createRequire`. In other runtimes, it returns a function that throws.
 * @returns {Function} The require function.
 */
declare const getRequire: () => any;

/**
 * General utility methods.
 */
declare const Utils: {
    /**
     * Logs the current runtime information.
     */
    run: () => void;
};
/**
 * Gets an environment variable value in a runtime-agnostic way.
 * Supports Node.js (`process.env`) and Deno (`Deno.env`).
 * @param {string} key - The environment variable name.
 * @returns {string | undefined} The value of the environment variable, or undefined if not set.
 */
declare const getEnv: (key: string) => string | undefined;
/**
 * Gets all environment variables as a record.
 * Supports Node.js and Deno.
 * @returns {Record<string, string | undefined>} An object containing all environment variables.
 */
declare const getAllEnv: () => Record<string, string | undefined>;
/**
 * Reads a text file synchronously in a runtime-agnostic way.
 * @param {string} file - The path to the file.
 * @returns {string} The contents of the file as a string.
 */
declare const readTextFileSync: (file: string) => string;
/**
 * Checks if a file or directory exists synchronously.
 * @param {string} file - The path to the file or directory.
 * @returns {boolean} True if it exists, false otherwise.
 */
declare const existsSync: (file: string) => boolean;
/**
 * Gets the current working directory in a runtime-agnostic way.
 * @returns {string} The current working directory path.
 */
declare const getCwd: () => string;
/**
 * Gets the directory name of the current module.
 * Handles `file:` URLs and edge runtimes.
 * @returns {string} The directory name.
 */
declare const getDirname: () => any;
/**
 * Gets the current platform section name.
 * @returns {"linux" | "windows"} The platform identifier.
 */
declare const getPlatform: () => "linux" | "windows";
/**
 * Gets the environment mode from `NODE_ENV`.
 * Defaults to 'development' if not set to 'production'.
 * @returns {"development" | "production"} The environment mode.
 */
declare const getMode: () => "development" | "production";
/**
 * Gets the path to the system temporary directory.
 * @returns {string} The temporary directory path.
 */
declare const getTempDir: () => string;
/**
 * Pauses execution for a specified number of milliseconds.
 *
 * @param {number} ms - The number of milliseconds to wait.
 * @returns {Promise<void>} A promise that resolves after the delay.
 */
declare const sleep: (ms: number) => Promise<void>;

export { type AsyncLocalStorageLike, type BaseDbConfig, ConfigManager, Core, type Database, type DatabaseResult, DatabaseSection, type DbDriver, type DbMode, type LibraryLogger, type PostgresConfig, PostgresDb, PostgresDriver, type PreparedDriverStatement, type QueryParams, type QueryResponse, RequestProxied, RequestResponseSerialize, type RequestResult, RequestUnlimited, Retrieve, type Runtime, type SerializedResponse, type SqliteConfig, SqliteDb, SqliteDriver, StrictLogger, SysInfo, Utils, coreFFI, createDatabase, detectRuntime, endPoint, endPoints, existsSync, getActiveTransaction, getAllEnv, getCwd, getDirname, getEnv, getMode, getPlatform, getRequire, getSysInfo, getTempDir, getVersion, handleDbError, includeExcludeCron, isFfiAvailable, logAndDouble, _default as logger, readTextFileSync, runInTransaction, sleep, transactionStorage, wrapError, wrapSuccess };
