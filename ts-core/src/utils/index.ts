// =============================================
// FILE: ts-core/src/utils/index.ts
// PURPOSE: Utils category – exported as named import
// Example: import { Utils } from '@ckir/corelib'
// =============================================

import { detectRuntime } from "../common/runtime";

export const Utils = {
	run: () => console.log(`[UTILS] Running on ${detectRuntime()}`),
};
