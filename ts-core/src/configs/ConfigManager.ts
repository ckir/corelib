// =============================================
// FILE: ts-core/src/configs/ConfigManager.ts
// PURPOSE: ConfigManager handles the lifecycle of the application's configuration.
// It manages globalThis.sysconfig and provides an event-driven interface
// for runtime updates.
// * Priority: CLI > Environment Variables > Config Files > Defaults
// =============================================

import { EventEmitter } from "node:events";
import { deepmergeCustom } from "deepmerge-ts";
import { serializeError } from "serialize-error";
import logger from "../loggers";
import {
	detectRuntime,
	existsSync,
	getAllEnv,
	getCwd,
	getDirname,
	getMode,
	getPlatform,
	getRequire,
	readTextFileSync,
} from "../utils";
import builtinDefaults from "./ConfigManager.json";
import { decryptConfig } from "./ConfigUtils";

/**
 * Custom merger: Overwrites leaf properties (primitives and arrays)
 * instead of merging them, as per requirements.
 */
const leafMerger = deepmergeCustom({
	mergeArrays: false,
});

/**
 * Rejects override keys whose dot/kebab segments would pollute the prototype
 * chain (__proto__, constructor, prototype) before they reach setPath.
 */
const isSafeKey = (key: string): boolean =>
	!key
		.split(/[.-]/)
		.some((p) => p === "__proto__" || p === "constructor" || p === "prototype");

/**
 * Resolve the application identity used to match a config's top-level section.
 *
 * Monorepo-aware: walks up from `cwd` to the nearest workspace root — a
 * directory containing `pnpm-workspace.yaml`, or a `package.json` with a
 * `workspaces` field — and returns that root folder's name, so every package
 * in a monorepo shares one app identity (the root folder name). When no
 * workspace marker is found it falls back to `basename(cwd)`, which is
 * byte-identical to the pre-monorepo behavior for standalone apps.
 *
 * Pure and dependency-injected (path module + filesystem probes) so it can be
 * unit-tested without touching the real filesystem or process cwd.
 */
export function resolveAppName(
	cwd: string,
	pathMod: {
		join: (...parts: string[]) => string;
		dirname: (p: string) => string;
		basename: (p: string) => string;
	},
	fileExists: (p: string) => boolean,
	readFile: (p: string) => string,
): string {
	let dir = cwd;
	for (;;) {
		if (fileExists(pathMod.join(dir, "pnpm-workspace.yaml")))
			return pathMod.basename(dir);
		const pkgPath = pathMod.join(dir, "package.json");
		if (fileExists(pkgPath)) {
			try {
				const pkg = JSON.parse(readFile(pkgPath)) as { workspaces?: unknown };
				if (pkg.workspaces) return pathMod.basename(dir);
			} catch {
				// Malformed package.json — skip it and keep walking up.
			}
		}
		const parent = pathMod.dirname(dir);
		if (parent === dir) break; // reached the filesystem root
		dir = parent;
	}
	return pathMod.basename(cwd);
}

/**
 * ConfigManager handles the lifecycle of the application's configuration.
 * It manages globalThis.sysconfig and provides an event-driven interface
 * for runtime updates.
 * * Priority: CLI > Environment Variables > Config Files > Defaults
 */
export class ConfigManager extends EventEmitter {
	private static instance: ConfigManager;
	private _config: Record<string, unknown> = {};
	private _defaultsPath: string;
	private static _logger = logger.child({ section: "ConfigManager" });

	private constructor() {
		super();
		const __dirname = getDirname();
		let defaultsPath = __dirname;

		try {
			const { join } = getRequire()("node:path");
			defaultsPath = join(__dirname, "ConfigManager.json");
		} catch (_e) {
			// In edge, we can't join paths or load files anyway
			defaultsPath = `${__dirname}/ConfigManager.json`;
		}

		this._defaultsPath = defaultsPath;

		// Initialize the Global Active Object if not already present
		if (!(globalThis as any).sysconfig) {
			(globalThis as any).sysconfig = this._config;
		}
	}

	/**
	 * Singleton accessor for the ConfigManager
	 */
	public static getInstance(): ConfigManager {
		if (!ConfigManager.instance) {
			ConfigManager.instance = new ConfigManager();
		}
		return ConfigManager.instance;
	}

	/**
	 * Retrieves a nested configuration value by string path (e.g., "db.mysql.port").
	 * @param {string} path - The dot-notation path to the configuration value.
	 * @returns The value at the specified path, or undefined if not found.
	 */
	public get(path: string): unknown {
		const keys = path.split(".");
		let current: unknown = this._config;

		for (const key of keys) {
			if (
				current === null ||
				typeof current !== "object" ||
				!(key in (current as Record<string, unknown>))
			) {
				return undefined;
			}
			current = (current as Record<string, unknown>)[key];
		}

		return current;
	}

	/**
	 * Static helper to retrieve a configuration value from the singleton instance.
	 */
	public static get(path: string): unknown {
		return ConfigManager.getInstance().get(path);
	}

	/**
	 * Main initialization sequence.
	 * 1. Load Defaults
	 * 2. Detect CLI -C flag for external config
	 * 3. Process Hierarchy (commonAll -> app -> platform -> mode)
	 * 4. Apply Env Overrides
	 * 5. Apply CLI Overrides
	 */
	public async initialize(args?: string[]): Promise<void> {
		// 1. Hardcoded Defaults
		this.loadDefaults();

		// 2. Parse argv with a dedicated parser (no commander): extract the
		// external-config path (-C/--config) and collect arbitrary --kebab
		// overrides. Guarded so edge runtimes without process.argv yield [].
		const argv =
			args ??
			(typeof process !== "undefined" && Array.isArray(process.argv)
				? process.argv.slice(2)
				: []);

		let configPath: string | undefined;
		const overrides: Record<string, string | boolean> = {};

		for (let i = 0; i < argv.length; i++) {
			const tok = argv[i];
			if (tok === "-C" || tok === "--config") {
				if (i + 1 < argv.length && !argv[i + 1].startsWith("-"))
					configPath = argv[++i];
				continue;
			}
			if (tok.startsWith("--config=")) {
				configPath = tok.slice("--config=".length);
				continue;
			}
			if (!tok.startsWith("--")) continue; // ignore bare operands

			let key = tok.slice(2);
			let value: string | boolean;
			const eq = key.indexOf("=");
			if (eq > -1) {
				value = key.slice(eq + 1);
				key = key.slice(0, eq);
			} else if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
				value = argv[++i];
			} else {
				value = true; // bare --flag → true
			}
			overrides[key] = value;
		}

		if (configPath) {
			const externalData = await this.fetchExternalConfig(configPath);
			this.processHierarchy(externalData);
		}

		// 3. Apply Environment Variables (CORELIB_ prefix)
		this.applyEnvOverrides();

		// 4. Apply CLI Overrides parsed above
		this.applyCliOverrides(overrides);

		// Finalize global object reference
		(globalThis as any).sysconfig = this._config;
		this.emit("initialized", this._config);
	}

	/**
	 * Retrieves the current active configuration object.
	 */
	public getConfig(): Record<string, unknown> {
		return this._config;
	}

	/**
	 * Public method to load and merge a new configuration from a URL or file path on demand.
	 * Respects the established configuration hierarchy and maintains Env overrides.
	 * @param source - The URL or local file path to the configuration.
	 */
	public async loadExternalConfig(source: string): Promise<void> {
		try {
			// 1. Fetch and parse the external configuration using existing logic
			const externalData = await this.fetchExternalConfig(source);

			// 2. Process it through the established hierarchy (commonAll -> app -> platform -> mode)
			this.processHierarchy(externalData);

			// 3. Re-apply environment variables to maintain precedence rules
			this.applyEnvOverrides();

			// 4. Update the global object reference
			(globalThis as any).sysconfig = this._config;

			// 5. Emit a general update event for listeners to react
			this.emit("configLoaded", this._config);
		} catch (error) {
			this.logError(
				`Failed to load external config dynamically from ${source}`,
				error,
			);
			throw error;
		}
	}

	/**
	 * Loads the base ConfigManager.json from the local directory.
	 * Always seeds from the bundled JSON (available in all runtimes, including edge).
	 * If the JSON file is also found on disk, it replaces the bundled defaults.
	 */
	private loadDefaults(): void {
		this._config = {
			...(builtinDefaults as unknown as Record<string, unknown>),
		};
		if (existsSync(this._defaultsPath)) {
			try {
				const raw = readTextFileSync(this._defaultsPath);
				this._config = JSON.parse(raw) as Record<string, unknown>;
			} catch (e) {
				this.logError("Failed to load defaults", e);
			}
		}
	}

	/**
	 * Fetches and parses configuration from a URL or Local Path.
	 * Supports .enc decryption and dynamic confbox parsing by extension.
	 */
	private async fetchExternalConfig(
		source: string,
	): Promise<Record<string, unknown>> {
		let content: string;

		if (source.startsWith("http")) {
			const { endPoint } = await import("../retrieve/RequestUnlimited");
			const result = await endPoint<string>(source);
			if (result.status === "error") {
				throw new Error("Failed to fetch external config");
			}
			content = result.value.body as string;
		} else {
			content = readTextFileSync(source);
		}

		const lowerSource = source.toLowerCase();

		if (lowerSource.endsWith(".enc")) {
			return this.validateConfigObject(await decryptConfig(content), source);
		}

		// Tree-shakable dynamic import for confbox
		const confbox = await import("confbox");

		// Detect filetype and parse
		if (lowerSource.endsWith(".yaml") || lowerSource.endsWith(".yml")) {
			return this.validateConfigObject(confbox.parseYAML(content), source);
		}
		if (lowerSource.endsWith(".toml")) {
			return this.validateConfigObject(confbox.parseTOML(content), source);
		}
		if (lowerSource.endsWith(".json5")) {
			return this.validateConfigObject(confbox.parseJSON5(content), source);
		}
		if (lowerSource.endsWith(".jsonc")) {
			return this.validateConfigObject(confbox.parseJSONC(content), source);
		}
		if (lowerSource.endsWith(".ini")) {
			return this.validateConfigObject(confbox.parseINI(content), source);
		}

		// Fallback to standard JSON
		return this.validateConfigObject(confbox.parseJSON(content), source);
	}

	private validateConfigObject(
		parsed: unknown,
		source: string,
	): Record<string, unknown> {
		if (
			parsed === null ||
			typeof parsed !== "object" ||
			Array.isArray(parsed)
		) {
			throw new Error(
				`Config from "${source}" must be a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
			);
		}
		return parsed as Record<string, unknown>;
	}

	/**
	 * Processes the specific hierarchy:
	 * commonAll -> [AppName].common -> [AppName].[platform] -> [AppName].[platform].[mode]
	 */
	private processHierarchy(data: Record<string, unknown>): void {
		if (!data) return;

		const appName = this.getAppName();
		const platform = getPlatform(); // linux | windows
		const mode = getMode(); // development | production

		// Start with commonAll as base
		let layeredConfig = (data.commonAll as Record<string, unknown>) || {};

		// Find App Section (Case Insensitive)
		const appKey = Object.keys(data).find(
			(k) => k.toLowerCase() === appName.toLowerCase(),
		);
		const appSection = appKey
			? (data[appKey] as Record<string, unknown>)
			: null;

		if (appSection) {
			// Layer 1: App Common
			if (appSection.common) {
				layeredConfig = leafMerger(
					layeredConfig,
					appSection.common as Record<string, unknown>,
				);
			}

			// Layer 2: Platform
			const platformSection = appSection[platform] as
				| Record<string, unknown>
				| undefined;
			if (platformSection) {
				// Layer 3: Mode
				const modeSection = platformSection[mode] as
					| Record<string, unknown>
					| undefined;
				if (modeSection) {
					layeredConfig = leafMerger(layeredConfig, modeSection);
				}
			}
		}

		this._config = leafMerger(this._config, layeredConfig) as Record<
			string,
			unknown
		>;
	}

	/**
	 * Maps CORELIB_ prefixed environment variables to config keys.
	 * Example: CORELIB_DB_PORT -> config.db.port
	 */
	private applyEnvOverrides(): void {
		const prefix = "CORELIB_";
		const env = getAllEnv();
		Object.keys(env).forEach((envKey) => {
			if (envKey.startsWith(prefix)) {
				const configPath = envKey
					.slice(prefix.length)
					.toLowerCase()
					.replace(/_/g, ".");
				const value = this.parseValue(env[envKey]);
				this.setPath(this._config, configPath, value);
			}
		});
	}

	/**
	 * Maps the parsed Kebab-case CLI overrides to the config structure.
	 * Unsafe keys (__proto__/constructor/prototype segments) are dropped.
	 */
	private applyCliOverrides(overrides: Record<string, string | boolean>): void {
		Object.keys(overrides).forEach((key) => {
			if (key === "config") return; // Skip -C/--config (consumed above)
			if (!isSafeKey(key)) {
				ConfigManager._logger.warn(
					`Dropped unsafe CLI override key "${key}" (prototype-pollution guard)`,
				);
				return;
			}
			const configPath = key.replace(/-/g, ".");
			const value = this.parseValue(overrides[key]);
			this.updateValue(configPath, value);
		});
	}

	/**
	 * Core update method that updates both the local object
	 * and the active globalThis object, then emits events.
	 */
	public updateValue(path: string, value: unknown): void {
		this.setPath(this._config, path, value);
		this.emit("change", { path, value });
		this.emit(`change:${path}`, value);
	}

	/**
	 * Helper to set nested object values by string path (e.g., "db.mysql.port")
	 */
	private setPath(
		obj: Record<string, unknown>,
		path: string,
		value: unknown,
	): void {
		const keys = path.split(".");
		let current: Record<string, unknown> = obj;

		while (keys.length > 1) {
			const key = keys.shift() as string;
			if (
				!(key in current) ||
				typeof current[key] !== "object" ||
				current[key] === null
			) {
				current[key] = {};
			}
			current = current[key] as Record<string, unknown>;
		}

		current[keys[0]] = value;
	}

	/**
	 * Parses values from Env/CLI, automatically handling JSON strings for arrays/objects.
	 */
	private parseValue(val: any): any {
		if (typeof val !== "string") return val;

		if (
			(val.startsWith("[") && val.endsWith("]")) ||
			(val.startsWith("{") && val.endsWith("}"))
		) {
			try {
				return JSON.parse(val);
			} catch (e) {
				this.logError("Failed to parse complex JSON from CLI/Env flag", e);
				return val;
			}
		}
		if (val.toLowerCase() === "true") return true;
		if (val.toLowerCase() === "false") return false;
		if (!Number.isNaN(Number(val)) && val.trim() !== "") return Number(val);

		return val;
	}

	private getAppName(): string {
		try {
			const runtime = detectRuntime();
			if (
				runtime === "node" ||
				runtime === "bun" ||
				(typeof import.meta !== "undefined" &&
					import.meta.url &&
					import.meta.url.startsWith("file:"))
			) {
				const path = getRequire()("node:path");
				return resolveAppName(
					getCwd(),
					path,
					(p: string) => existsSync(p),
					(p: string) => readTextFileSync(p),
				);
			}
			return "edge-app";
		} catch (e) {
			this.logError(
				"Failed to get app name from cwd. Falling back to default-app",
				e,
			);
			return "default-app";
		}
	}

	/**
	 * Logs errors internally. If the global pino logger is available, it uses it
	 * along with `serialize-error` to structure the error object for Vector sidecars.
	 */
	private logError(msg: string, error?: unknown): void {
		const serialized = error ? serializeError(error) : undefined;
		ConfigManager._logger.error(msg, { error: serialized });
	}

	// --- Rust Integration Helpers ---

	public toJsonString(): string {
		return JSON.stringify(this._config);
	}

	public toBuffer(): Buffer {
		return Buffer.from(this.toJsonString());
	}
}
