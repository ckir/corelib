// =============================================
// FILE: ts-core/src/configs/index.ts
// PURPOSE: Configs category – exported as named import
// Example: import { Configs } from '@ckir/corelib'
// =============================================

import { detectRuntime } from "../common/runtime";

export const Configs = {
	run: () => console.log(`[CONFIGS] Running on ${detectRuntime()}`),
};
