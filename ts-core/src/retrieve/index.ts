// =============================================
// FILE: ts-core/src/retrieve/index.ts
// PURPOSE: Retrieve category – exported as named import
// Example: import { Retrieve, RequestUnlimited } from '@ckir/corelib'
// NEW (2026-03-07): Added exports for RequestUnlimited and related types/utilities.
// =============================================

import { detectRuntime } from "../utils/runtime";

export const Retrieve = {
	run: () => console.log(`[RETRIEVE] Running on ${detectRuntime()}`),
};

export type { SerializedResponse } from "./RequestResponseSerialize";
export { RequestResponseSerialize } from "./RequestResponseSerialize";
export type { RequestResult } from "./RequestUnlimited";
export {
	endPoint,
	endPoints,
	RequestUnlimited,
} from "./RequestUnlimited";
