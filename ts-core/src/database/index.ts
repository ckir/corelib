// =============================================
// FILE: ts-core/src/database/index.ts
// PURPOSE: Database category – runtime features
// Example: Bun uses built-in SQLite
// =============================================

import { detectRuntime } from "../common/runtime";

const runtime = detectRuntime();

export const Database = {
	connect: () => {
		if (runtime === "bun") {
			// Bun feature: built-in SQLite
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
