// =============================================
// FILE: ts-core/src/database/index.ts
// PURPOSE: Database category – exported as named import
// Example: import { Database } from '@ckir/corelib'
// =============================================

import { detectRuntime } from "../common/runtime";

export const Database = {
	run: () => console.log(`[DATABASE] Running on ${detectRuntime()}`),
};
