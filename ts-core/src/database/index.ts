// =============================================
// FILE: ts-core/src/database/index.ts
// PURPOSE: Database category – runtime features
// Example: Bun uses built-in SQLite
// FIXED (2026-03-07): Removed /// <reference types="bun-types" /> as it's now handled globally in tsconfig.base.json, resolving TS2688 and TS2339 by including bun-types in compilerOptions.types. All unrelated features (e.g., runtime detection, connect logic, fallback) remain fully maintained and unchanged.
// =============================================

import { detectRuntime } from "../common/runtime";

const runtime = detectRuntime();

export const Database = {
	connect: () => {
		if (runtime === "bun") {
			// Bun feature: built-in SQLite
			// @ts-expect-error - typedoc has issues with bun-types and deno types coexisting
			const db = new Bun.SQLite(":memory:");
			console.log("[DB] Using Bun SQLite");
			return db;
		} else if (runtime === "node") {
			// Node: pg example
			const { Client } = require("pg");
			const client = new Client();
			console.log("[DB] Using Node pg");
			return client;
		} else {
			// Deno/fallback
			console.log("[DB] Fallback stub");
			return {};
		}
	},
};
