// =============================================
// FILE: ts-markets/src/nasdaq/MarketStatus.ts
// PURPOSE: Fetches and processes Nasdaq market status information.
// Uses Luxon for date/time handling and integrates with ApiNasdaqUnlimited.
// =============================================

import { ConfigManager, logger, nextCid } from "@ckir/corelib";
import { DateTime } from "luxon";
import { serializeError } from "serialize-error";
import { ApiNasdaqUnlimited, type NasdaqResult } from "./ApiNasdaqUnlimited";

/**
 * Interface matching the raw JSON data structure from Nasdaq API's "data" field.
 */
export interface NasdaqMarketInfo {
	/** Country associated with the market. */
	country: string;
	/** Human-readable market status indicator (e.g., "Market Open"). */
	marketIndicator: string;
	/** UI-optimized market status indicator. */
	uiMarketIndicator: string;
	/** Human-readable countdown to market open/close (e.g., "Market Closes in 3H 37M"). */
	marketCountDown: string;
	/** Simplified market status (e.g., "Open", "Closed", "Pre Market", "After Hours"). */
	mrktStatus: string;
	/** Numeric or UI-optimized market countdown. */
	mrktCountDown: string;

	/** Pre-market opening time (e.g., "Mar 9, 2026 04:00 AM ET"). */
	preMarketOpeningTime: string;
	/** Pre-market closing time. */
	preMarketClosingTime: string;
	/** Regular market opening time. */
	marketOpeningTime: string;
	/** Regular market closing time. */
	marketClosingTime: string;
	/** After-hours market opening time. */
	afterHoursMarketOpeningTime: string;
	/** After-hours market closing time. */
	afterHoursMarketClosingTime: string;

	/** Previous trading date string (e.g., "Mar 6, 2026"). */
	previousTradeDate: string;
	/** Next trading date string (e.g., "Mar 10, 2026"). */
	nextTradeDate: string;

	/** Raw pre-market opening time in ISO format (NY time, no offset). e.g. "2026-03-09T04:00:00" */
	pmOpenRaw: string;
	/** Raw regular market opening time in ISO format. */
	openRaw: string;
	/** Raw regular market closing time in ISO format. */
	closeRaw: string;
	/** Raw after-hours market closing time in ISO format. */
	ahCloseRaw: string;

	/** Indicates if the current date is a business day for the market. */
	isBusinessDay: boolean;
}

const DEFAULT_ENDPOINT = "https://api.nasdaq.com/api/market-info";
const ZONE = "America/New_York";

const marketStatusLogger = logger.child({ section: "MarketStatus" });

/**
 * Calculates how long to sleep/wait based on market status in milliseconds.
 * Useful for polling services that need to wait for market open.
 *
 * @param {NasdaqMarketInfo} data - The current market information.
 * @returns {number} The sleep duration in milliseconds.
 */
function getSleepDuration(data: NasdaqMarketInfo): number {
	// 1. Current NY Time
	const now = DateTime.now().setZone(ZONE);

	// 2. If Open, no sleep (0 ms)
	if (data.mrktStatus === "Open") {
		return 0;
	}

	// 3. Parse Raw Times (Input is local NY time ISO without 'Z')
	const pmOpen = DateTime.fromISO(data.pmOpenRaw, {
		zone: ZONE,
	});
	const marketOpen = DateTime.fromISO(data.openRaw, {
		zone: ZONE,
	});

	// 4. Determine Target
	let target = now < pmOpen ? pmOpen : marketOpen;

	// 5. Handle Weekends/Holidays (If target is in the past)
	if (target <= now) {
		// Format: "MMM d, yyyy" -> e.g., "Mar 10, 2026"
		const nextTrade = DateTime.fromFormat(data.nextTradeDate, "MMM d, yyyy", {
			zone: ZONE,
		});

		if (nextTrade.isValid) {
			// Set to 04:00:00 NY time (pre-market open)
			target = nextTrade.set({
				hour: 4,
				minute: 0,
				second: 0,
				millisecond: 0,
			});
		} else {
			marketStatusLogger.warn("Failed to parse nextTradeDate", {
				date: data.nextTradeDate,
			});
			return 300 * 1000; // 5 minutes
		}
	}

	// 6. Calculate Diff
	if (target > now) {
		const diff = target.diff(now);
		marketStatusLogger.debug(
			`Target NY Open: ${target.toFormat("yyyy-MM-dd HH:mm:ss")} (${diff.toFormat("hh:mm:ss")} remaining)`,
		);
		const ms = diff.as("milliseconds");
		return ms > 0 ? ms : 60 * 1000; // Minimum 1 minute
	}

	// Default fallback: If target is STILL <= now after nextTradeDate adjustment
	// we must be exactly at target or something is wrong.
	return 60 * 1000;
}

/**
 * Fetches the current market status from Nasdaq API.
 * Performs strict schema validation on the response.
 *
 * @returns {Promise<NasdaqResult<NasdaqMarketInfo>>} A promise resolving to a NasdaqResult.
 */
async function getStatus(): Promise<NasdaqResult<NasdaqMarketInfo>> {
	const endpoint =
		(ConfigManager.get("markets.nasdaq.statusEndpoint") as
			| string
			| undefined) ?? DEFAULT_ENDPOINT;
	// Flight-recorder: cid pairs this status fetch's start with its terminus.
	const cid = nextCid();
	const startedAt = performance.now();
	marketStatusLogger.trace("status: fetch", { cid });
	try {
		const result =
			await ApiNasdaqUnlimited.endPoint<NasdaqMarketInfo>(endpoint);

		// Path 1: API returned an error status
		if (result.status === "error") {
			const errorData = serializeError(result.reason);
			const reasonSerialized = {
				...errorData,
				message: errorData.message || "Nasdaq API returned an error status",
			};

			marketStatusLogger.trace("status: error", {
				cid,
				durationMs: performance.now() - startedAt,
				errorMsg: reasonSerialized.message,
			});
			marketStatusLogger.error("Fetch Failed", {
				cid,
				reason: reasonSerialized,
			});
			return { status: "error", reason: reasonSerialized };
		}

		const data = result.value;

		// Path 2: API succeeded but data is malformed (Schema Validation)
		if (
			!data?.mrktStatus ||
			!data.nextTradeDate ||
			!data.pmOpenRaw ||
			!data.openRaw
		) {
			const msg = "STRICT SCHEMA VALIDATION FAILED: Missing required fields";
			const payload = serializeError(data);

			marketStatusLogger.trace("status: error", {
				cid,
				durationMs: performance.now() - startedAt,
				errorMsg: msg,
				schemaValid: false,
			});
			marketStatusLogger.warn(msg, { cid, payload });
			return {
				status: "error",
				reason: { message: msg, payload },
			};
		}

		// Path 3: Success
		marketStatusLogger.trace("status: ok", {
			cid,
			durationMs: performance.now() - startedAt,
			marketStatus: data.mrktStatus,
			schemaValid: true,
		});
		return {
			status: "success",
			value: data,
			details: result.details,
		};
	} catch (e) {
		// Path 4: Unexpected Exception (Network failure, parsing crash, etc.)
		const errorData = serializeError(e);
		const serializedReason = {
			...errorData,
			message: errorData.message || "Unexpected MarketStatus Exception",
		};

		marketStatusLogger.trace("status: error", {
			cid,
			durationMs: performance.now() - startedAt,
			errorMsg: serializedReason.message,
		});
		marketStatusLogger.error("Unexpected Error", {
			cid,
			error: serializedReason,
		});
		return {
			status: "error",
			reason: serializedReason,
		};
	}
}

/**
 * Market status utility.
 */
export const MarketStatus = {
	/**
	 * Fetches the current market status.
	 */
	getStatus,
	/**
	 * Calculates the sleep duration until next market phase.
	 */
	getSleepDuration,
};
