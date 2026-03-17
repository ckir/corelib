// =============================================
// FILE: ts-markets/src/nasdaq/MarketStatus.ts
// PURPOSE: Fetches and processes Nasdaq market status information.
// Uses Luxon for date/time handling and integrates with ApiNasdaqUnlimited.
// =============================================

import { logger } from "@ckir/corelib";
import { DateTime } from "luxon";
import { serializeError } from "serialize-error";
import { ApiNasdaqUnlimited, type NasdaqResult } from "./ApiNasdaqUnlimited";

/**
 * Interface matching the raw JSON data structure from Nasdaq API's "data" field.
 */
export interface NasdaqMarketInfo {
	country: string;
	marketIndicator: string; // e.g., "Market Open"
	uiMarketIndicator: string;
	marketCountDown: string; // e.g., "Market Closes in 3H 37M"
	mrktStatus: string; // e.g., "Open" | "Closed" | "Pre Market" | "After Hours"
	mrktCountDown: string;

	// Additional fields from API response
	preMarketOpeningTime: string; // e.g., "Mar 9, 2026 04:00 AM ET"
	preMarketClosingTime: string;
	marketOpeningTime: string;
	marketClosingTime: string;
	afterHoursMarketOpeningTime: string;
	afterHoursMarketClosingTime: string;

	// Date Strings
	previousTradeDate: string; // e.g., "Mar 6, 2026"
	nextTradeDate: string; // e.g., "Mar 10, 2026"

	// Raw ISO strings (NY Time, no offset in string)
	pmOpenRaw: string; // "2026-03-09T04:00:00"
	openRaw: string; // "2026-03-09T09:30:00"
	closeRaw: string; // "2026-03-09T16:00:00"
	ahCloseRaw: string; // "2026-03-09T20:00:00"

	isBusinessDay: boolean;
}

const ENDPOINT = "https://api.nasdaq.com/api/market-info";
const ZONE = "America/New_York";

/**
 * Calculates how long to sleep/wait based on market status in milliseconds.
 * Mirrors the logic from marketstatus.rs using Luxon.
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
			logger?.warn("[MarketStatus] Failed to parse nextTradeDate", {
				date: data.nextTradeDate,
			});
			return 300 * 1000; // 5 minutes
		}
	}

	// 6. Calculate Diff
	if (target > now) {
		const diff = target.diff(now);
		logger?.debug(
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
 * Fetches the current market status.
 * Guaranteed to return a NasdaqResult without "falling through" to undefined.
 */
async function getStatus(): Promise<NasdaqResult<NasdaqMarketInfo>> {
	try {
		const result =
			await ApiNasdaqUnlimited.endPoint<NasdaqMarketInfo>(ENDPOINT);

		// Path 1: API returned an error status
		if (result.status === "error") {
			const errorData = serializeError(result.reason);
			const reasonSerialized = {
				...errorData,
				message: errorData.message || "Nasdaq API returned an error status",
			};

			logger?.error("[MarketStatus] Fetch Failed", {
				reason: reasonSerialized,
			});
			return { status: "error", reason: reasonSerialized };
		}

		const data = result.value;

		// Path 2: API succeeded but data is malformed (Schema Validation)
		if (
			!data ||
			!data.mrktStatus ||
			!data.nextTradeDate ||
			!data.pmOpenRaw ||
			!data.openRaw
		) {
			const msg = "STRICT SCHEMA VALIDATION FAILED: Missing required fields";
			const payload = serializeError(data);

			logger?.fatal(msg, { payload });
			return {
				status: "error",
				reason: { message: msg, payload },
			};
		}

		// Path 3: Success
		logger?.trace("[MarketStatus] Schema validated successfully");
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

		logger?.error("[MarketStatus] Unexpected Error", {
			error: serializedReason,
		});
		return {
			status: "error",
			reason: serializedReason,
		};
	}
}

export const MarketStatus = {
	getStatus,
	getSleepDuration,
};
