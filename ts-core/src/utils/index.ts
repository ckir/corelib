// =============================================
// FILE: ts-core/src/utils/index.ts
// PURPOSE: Utils category – exported as named import
// Example: import { Utils, SysInfo } from '@ckir/corelib'
// NEW: Re-exports SysInfo for telemetry
// NEW: Multi-runtime abstractions for env, file, cwd, dirname
// NEW: Added getPlatform and getMode from ConfigUtils
// =============================================

import { createRequire } from "node:module";
import { detectRuntime } from "./runtime";

const require = createRequire(import.meta.url);

export { includeExcludeCron } from "./cron";
export { detectRuntime, type Runtime } from "./runtime";
export { getSysInfo, SysInfo } from "./SysInfo";

export const Utils = {
	run: () => console.log(`[UTILS] Running on ${detectRuntime()}`),
};

export const getEnv = (key: string): string | undefined => {
	if (detectRuntime() === "deno") {
		return Deno.env.get(key);
	} else {
		return process.env[key];
	}
};

export const getAllEnv = (): Record<string, string | undefined> => {
	if (detectRuntime() === "deno") {
		return Deno.env.toObject();
	} else {
		return { ...process.env };
	}
};

export const readTextFileSync = (file: string): string => {
	if (detectRuntime() === "deno") {
		return Deno.readTextFileSync(file);
	} else {
		const { readFileSync } = require("node:fs");
		return readFileSync(file, "utf8");
	}
};

export const existsSync = (file: string): boolean => {
	if (detectRuntime() === "deno") {
		try {
			Deno.statSync(file);
			return true;
		} catch {
			return false;
		}
	} else {
		const { existsSync } = require("node:fs");
		return existsSync(file);
	}
};

export const getCwd = (): string => {
	if (detectRuntime() === "deno") {
		return Deno.cwd();
	} else {
		return process.cwd();
	}
};

export const getDirname = () => {
	if (detectRuntime() === "deno") {
		return new URL(".", import.meta.url).pathname;
	} else {
		const { dirname } = require("node:path");
		const { fileURLToPath } = require("node:url");
		return dirname(fileURLToPath(import.meta.url));
	}
};

/**
 * Gets the current platform section name
 */
export const getPlatform = (): "linux" | "windows" => {
	const runtime = detectRuntime();
	let plat: string;
	if (runtime === "deno") {
		plat = Deno.build.os;
	} else {
		plat = process.platform;
	}
	return plat === "win32" || plat === "windows" ? "windows" : "linux";
};

/**
 * Gets the environment mode from NODE_ENV
 */
export const getMode = (): "development" | "production" => {
	const env = getEnv("NODE_ENV")?.toLowerCase();
	return env === "production" ? "production" : "development";
};

export const getTempDir = (): string => {
	if (detectRuntime() === "deno") {
		return Deno.env.get("TMPDIR") || Deno.env.get("TEMP") || "/tmp";
	} else {
		const os = require("node:os");
		return os.tmpdir();
	}
};
