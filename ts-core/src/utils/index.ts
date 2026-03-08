// =============================================
// FILE: ts-core/src/utils/index.ts
// PURPOSE: Utils category – exported as named import
// Example: import { Utils, SysInfo } from '@ckir/corelib'
// NEW: Re-exports SysInfo for telemetry
// =============================================

import { detectRuntime } from "../common/runtime";

export const Utils = {
	run: () => console.log(`[UTILS] Running on ${detectRuntime()}`),
};

export { getSysInfo, SysInfo } from "./SysInfo";
