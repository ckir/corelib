// =============================================
// FILE: ts-markets/src/nasdaq/symbolFiles.ts
// PURPOSE: Download the two Nasdaq symbol-directory files (nasdaqlisted.txt, otherlisted.txt) from an
// ordered list of sources (ftp:// first, https:// fallback) and refuse bodies that are not those files.
// =============================================

import { Writable } from "node:stream";
import { endPoints } from "@ckirg/corelib";

/** First line of nasdaqlisted.txt; anything else (e.g. a bot-challenge HTML page) is not the file. */
export const NASDAQ_LISTED_HEADER = "Symbol|Security Name|";
/** First line of otherlisted.txt. */
export const OTHER_LISTED_HEADER = "ACT Symbol|Security Name|";

const DEFAULT_FTP_TIMEOUT_MS = 15_000;

const HTTP_HEADERS = {
	accept: "text/plain, */*",
	"user-agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
};

/** One place to get both files from. */
export interface SymbolSource {
	nasdaqUrl: string;
	otherUrl: string;
}

export type SymbolFilesResult =
	| { status: "success"; nasdaqText: string; otherText: string }
	| { status: "error"; reason: { message: string; [key: string]: unknown } };

/**
 * Throws unless `text` starts with the expected header line. A 200 response can carry an HTML
 * bot-challenge or error page; that must count as a failed download (retry / next source), not as a
 * file that later parses to zero rows.
 */
export function assertSymbolFile(
	text: string,
	header: string,
	url: string,
): void {
	const body = text.replace(/^﻿/, "").trimStart();
	if (!body.startsWith(header)) {
		const sample = body.slice(0, 40).replace(/\s+/g, " ");
		throw new Error(
			`${url} did not return a symbol directory file (expected it to start with "${header}", got "${sample}")`,
		);
	}
}

const isFtp = (url: string): boolean => /^ftp:\/\//i.test(url);

// One shared import: concurrent refreshes must not each trigger their own dynamic import().
let ftpModule: Promise<typeof import("basic-ftp")> | undefined;
const loadFtp = (): Promise<typeof import("basic-ftp")> =>
	(ftpModule ??= import("basic-ftp"));

/**
 * Downloads `urls` (all ftp://) in order, reusing one anonymous connection per host:port. FTP control
 * connections are strictly sequential, so files on one host are fetched one after another.
 */
async function downloadFtp(
	urls: readonly string[],
	timeoutMs: number,
): Promise<string[]> {
	const { Client } = await loadFtp();
	const texts = new Array<string>(urls.length);
	const byHost = new Map<string, number[]>();
	urls.forEach((url, i) => {
		const u = new URL(url);
		const key = `${u.hostname}:${u.port || "21"}`;
		byHost.set(key, [...(byHost.get(key) ?? []), i]);
	});
	for (const indexes of byHost.values()) {
		const first = urls[indexes[0] as number] as string;
		const u = new URL(first);
		const client = new Client(timeoutMs);
		try {
			await client.access({
				host: u.hostname,
				port: Number(u.port) || 21,
				user: "anonymous",
				password: "anonymous@",
				secure: false, // ftp.nasdaqtrader.com is plain FTP; AUTH TLS is rejected
			});
			for (const i of indexes) {
				const remote = decodeURIComponent(new URL(urls[i] as string).pathname);
				const chunks: Buffer[] = [];
				await client.downloadTo(
					new Writable({
						write(chunk, _encoding, done) {
							chunks.push(Buffer.from(chunk));
							done();
						},
					}),
					remote,
				);
				texts[i] = Buffer.concat(chunks).toString("utf8");
			}
		} finally {
			client.close();
		}
	}
	return texts;
}

/** Fetches the bodies of `urls` in order: ftp:// over one connection per host, everything else via endPoints. */
async function fetchBodies(
	urls: readonly string[],
	timeoutMs: number,
): Promise<string[]> {
	const bodies = new Array<string>(urls.length);
	const ftpIdx = urls.flatMap((u, i) => (isFtp(u) ? [i] : []));
	const httpIdx = urls.flatMap((u, i) => (isFtp(u) ? [] : [i]));

	if (ftpIdx.length > 0) {
		const texts = await downloadFtp(
			ftpIdx.map((i) => urls[i] as string),
			timeoutMs,
		);
		ftpIdx.forEach((i, n) => {
			bodies[i] = texts[n] as string;
		});
	}
	if (httpIdx.length > 0) {
		const results = await endPoints<string>(
			httpIdx.map((i) => urls[i] as string),
			{ headers: HTTP_HEADERS },
		);
		for (const [n, i] of httpIdx.entries()) {
			const result = results[n];
			if (result === undefined) {
				throw new Error("endPoints returned fewer results than URLs requested");
			}
			if (result.status !== "success") {
				const reason = result.reason as { message?: string } | undefined;
				throw new Error(
					`${urls[i]}: ${reason?.message ?? JSON.stringify(result.reason)}`,
				);
			}
			bodies[i] = result.value.body as string;
		}
	}
	return bodies;
}

/**
 * Tries each source in order and returns the first one whose two files download AND validate.
 * Every failure is recorded, so the final error names each source and why it was rejected.
 */
export async function fetchSymbolFiles(
	sources: readonly SymbolSource[],
	timeoutMs: number = DEFAULT_FTP_TIMEOUT_MS,
): Promise<SymbolFilesResult> {
	const failures: string[] = [];
	for (const source of sources) {
		try {
			const [nasdaqText, otherText] = await fetchBodies(
				[source.nasdaqUrl, source.otherUrl],
				timeoutMs,
			);
			assertSymbolFile(
				nasdaqText as string,
				NASDAQ_LISTED_HEADER,
				source.nasdaqUrl,
			);
			assertSymbolFile(
				otherText as string,
				OTHER_LISTED_HEADER,
				source.otherUrl,
			);
			return {
				status: "success",
				nasdaqText: nasdaqText as string,
				otherText: otherText as string,
			};
		} catch (err) {
			failures.push(err instanceof Error ? err.message : String(err));
		}
	}
	return {
		status: "error",
		reason: {
			message: failures.join(" | ") || "no symbol directory source configured",
			failures,
		},
	};
}
