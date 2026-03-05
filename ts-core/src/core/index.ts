// =============================================
// FILE: ts-core/src/core/index.ts
// PURPOSE: Core category – exported as named import
// Example: import { Core } from '@ckir/corelib'
// =============================================

import { detectRuntime } from "../common/runtime";

export const Core = {
	run: () => console.log(`[CORE] Running on ${detectRuntime()}`),
};
