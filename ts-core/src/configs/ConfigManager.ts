// =============================================
// FILE: ts-core/src/configs/ConfigManager.ts
// PURPOSE: ConfigManager handles the lifecycle of the application's configuration.
// It manages globalThis.sysconfig and provides an event-driven interface
// for runtime updates.
// * Priority: CLI > Environment Variables > Config Files > Defaults
// =============================================

import { EventEmitter } from "node:events";
import { join } from "node:path";
import { Command } from "commander";
import { deepmergeCustom } from "deepmerge-ts";
import { serializeError } from "serialize-error";
import {
	existsSync,
	getAllEnv,
	getCwd,
	getDirname,
	getMode,
	getPlatform,
	readTextFileSync,
} from "../utils";
import { decryptConfig } from "./ConfigUtils";

/**
 * Custom merger: Overwrites leaf properties (primitives and arrays)
 * instead of merging them, as per requirements.
 */
const leafMerger = deepmergeCustom({
	mergeArrays: false,
});

/**
 * ConfigManager handles the lifecycle of the application's configuration.
 * It manages globalThis.sysconfig and provides an event-driven interface
 * for runtime updates.
 * * Priority: CLI > Environment Variables > Config Files > Defaults
 */
export class ConfigManager extends EventEmitter {
	private static instance: ConfigManager;
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic configuration type
	private _config: any = {};
	private _defaultsPath: string;

	private constructor() {
		super();
		const __dirname = getDirname();
		this._defaultsPath = join(__dirname, "ConfigManager.json");

		// Initialize the Global Active Object if not already present
		// biome-ignore lint/suspicious/noExplicitAny: Legacy global access
		if (!(globalThis as any).sysconfig) {
			// biome-ignore lint/suspicious/noExplicitAny: Legacy global access
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
	 * Main initialization sequence.
	 * 1. Load Defaults
	 * 2. Detect CLI -C flag for external config
	 * 3. Process Hierarchy (commonAll -> app -> platform -> mode)
	 * 4. Apply Env Overrides
	 * 5. Apply CLI Overrides
	 */
	public async initialize(): Promise<void> {
		// 1. Hardcoded Defaults
		this.loadDefaults();

		// Manual extraction of arguments
		const args = process.argv.slice(2);

		// 2. Parse with commander for -C and dynamic overrides
		const program = new Command();
		program.option("-C, --config <path>", "external config file or URL");
		program.allowUnknownOption(true);
		program.helpOption(false); // Suppress auto-help to match original; adjust if needed
		await program.parseAsync(args, { from: "user" });

		const configPath = program.opts().config;

		if (configPath) {
			const externalData = await this.fetchExternalConfig(configPath);
			this.processHierarchy(externalData);
		}

		// 3. Apply Environment Variables (CORELIB_ prefix)
		this.applyEnvOverrides();

		// 4. Apply CLI Overrides from parsed args
		await this.applyCliOverrides(program);

		// Finalize global object reference
		// biome-ignore lint/suspicious/noExplicitAny: Legacy global access
		(globalThis as any).sysconfig = this._config;
		this.emit("initialized", this._config);
	}

	/**
	 * Retrieves the current active configuration object.
	 * @returns {any} The current configuration state.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic configuration type
	public getConfig(): any {
		return this._config;
	}

	/**
	 * Loads the base ConfigManager.json from the local directory
	 */
	private loadDefaults(): void {
		if (existsSync(this._defaultsPath)) {
			try {
				const raw = readTextFileSync(this._defaultsPath);
				this._config = JSON.parse(raw);
			} catch (e) {
				this.logError("Failed to load defaults", e);
			}
		}
	}

	/**
	 * Fetches and parses configuration from a URL or Local Path.
	 * Supports .enc decryption and dynamic confbox parsing by extension.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic configuration type
	private async fetchExternalConfig(source: string): Promise<any> {
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
			return await decryptConfig(content);
		}

		// Tree-shakable dynamic import for confbox
		const confbox = await import("confbox");

		// Detect filetype and parse
		if (lowerSource.endsWith(".yaml") || lowerSource.endsWith(".yml")) {
			return confbox.parseYAML(content);
		}
		if (lowerSource.endsWith(".toml")) {
			return confbox.parseTOML(content);
		}
		if (lowerSource.endsWith(".json5")) {
			return confbox.parseJSON5(content);
		}
		if (lowerSource.endsWith(".jsonc")) {
			return confbox.parseJSONC(content);
		}
		if (lowerSource.endsWith(".ini")) {
			return confbox.parseINI(content);
		}

		// Fallback to standard JSON
		return confbox.parseJSON(content);
	}

	/**
	 * Processes the specific hierarchy:
	 * commonAll -> [AppName].common -> [AppName].[platform] -> [AppName].[platform].[mode]
	 */
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic configuration type
	private processHierarchy(data: any): void {
		if (!data) return;

		const appName = this.getAppName();
		const platform = getPlatform(); // linux | windows
		const mode = getMode(); // development | production

		// Start with commonAll as base
		let layeredConfig = data.commonAll || {};

		// Find App Section (Case Insensitive)
		const appKey = Object.keys(data).find(
			(k) => k.toLowerCase() === appName.toLowerCase(),
		);
		const appSection = appKey ? data[appKey] : null;

		if (appSection) {
			// Layer 1: App Common
			if (appSection.common) {
				layeredConfig = leafMerger(layeredConfig, appSection.common);
			}

			// Layer 2: Platform
			const platformSection = appSection[platform];
			if (platformSection) {
				// Layer 3: Mode
				const modeSection = platformSection[mode];
				if (modeSection) {
					layeredConfig = leafMerger(layeredConfig, modeSection);
				}
			}
		}

		this._config = leafMerger(this._config, layeredConfig);
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
	 * Maps Kebab-case CLI arguments to the config structure.
	 */
	private async applyCliOverrides(program: Command): Promise<void> {
		// biome-ignore lint/suspicious/noExplicitAny: Dynamic CLI overrides
		const overrides: Record<string, any> = {};
		let i = 0;
		while (i < program.args.length) {
			const arg = program.args[i];
			if (arg.startsWith("--")) {
				let key = arg.slice(2);
				// biome-ignore lint/suspicious/noExplicitAny: Dynamic CLI value
				let value: any;
				const eqIdx = key.indexOf("=");
				if (eqIdx > -1) {
					value = key.slice(eqIdx + 1);
					key = key.slice(0, eqIdx);
				} else {
					i++;
					value = i < program.args.length ? program.args[i] : true;
				}
				overrides[key] = value;
			}
			i++;
		}

		Object.keys(overrides).forEach((key) => {
			if (key === "config") return; // Skip -C
			const configPath = key.replace(/-/g, ".");
			const value = this.parseValue(overrides[key]);
			this.updateValue(configPath, value);
		});
	}

	/**
	 * Core update method that updates both the local object
	 * and the active globalThis object, then emits events.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic update value
	public updateValue(path: string, value: any): void {
		this.setPath(this._config, path, value);
		this.emit("change", { path, value });
		this.emit(`change:${path}`, value);
	}

	/**
	 * Helper to set nested object values by string path (e.g., "db.mysql.port")
	 */
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic object for nested config
	private setPath(obj: any, path: string, value: any): void {
		const keys = path.split(".");
		let current = obj;

		while (keys.length > 1) {
			const key = keys.shift() as string;
			if (!(key in current)) current[key] = {};
			current = current[key];
		}

		current[keys[0]] = value;
	}

	/**
	 * Parses values from Env/CLI, automatically handling JSON strings for arrays/objects.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic parsed value
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
			const { basename } = require("node:path");
			return basename(getCwd());
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
		// biome-ignore lint/suspicious/noExplicitAny: Legacy global logger access
		if ((globalThis as any).logger) {
			// biome-ignore lint/suspicious/noExplicitAny: Legacy global logger access
			(globalThis as any).logger.error(msg, { error: serialized });
		} else {
			console.error(`❌ [ConfigManager] ${msg}`, serialized || "");
		}
	}

	// --- Rust Integration Helpers ---

	public toJsonString(): string {
		return JSON.stringify(this._config);
	}

	public toBuffer(): Buffer {
		return Buffer.from(this.toJsonString());
	}
}
