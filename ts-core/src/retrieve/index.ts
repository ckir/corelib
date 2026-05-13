// =============================================
// FILE: ts-core/src/retrieve/index.ts
// PURPOSE: Retrieve category – exported as named import
// Example: import { Retrieve, RequestUnlimited } from '@ckir/corelib'
// NEW (2026-03-07): Added exports for RequestUnlimited and related types/utilities.
// =============================================

import logger from "../loggers";
import { detectRuntime } from "../utils/runtime";

const retrieveLogger = logger.child({ section: "Retrieve" });

export const Retrieve = {
	run: () => retrieveLogger.info(`Running on ${detectRuntime()}`),
};

export { RequestProxied } from "./RequestProxied";
export type { SerializedResponse } from "./RequestResponseSerialize";
export { RequestResponseSerialize } from "./RequestResponseSerialize";
export type { RequestResult } from "./RequestUnlimited";
export {
	endPoint,
	endPoints,
	RequestUnlimited,
} from "./RequestUnlimited";
