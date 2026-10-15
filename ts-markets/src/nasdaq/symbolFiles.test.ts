import * as corelib from "@ckirg/corelib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	assertSymbolFile,
	fetchSymbolFiles,
	NASDAQ_LISTED_HEADER,
	OTHER_LISTED_HEADER,
	type SymbolSource,
} from "./symbolFiles";

const ftp = vi.hoisted(() => ({
	access: vi.fn(),
	downloadTo: vi.fn(),
	close: vi.fn(),
	constructed: vi.fn(),
}));

vi.mock("basic-ftp", () => ({
	Client: class {
		constructor(timeout?: number) {
			ftp.constructed(timeout);
		}
		access = ftp.access;
		downloadTo = ftp.downloadTo;
		close = ftp.close;
	},
}));

vi.mock("@ckirg/corelib", async (importOriginal) => {
	const actual = await importOriginal<typeof corelib>();
	return { ...actual, endPoints: vi.fn() };
});

const NASDAQ_FILE = `Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares
AAPL|Apple Inc.|Q|N|N|100|N|N
`;
const OTHER_FILE = `ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol
A|Agilent|N|A|N|100|N|A
`;
const HTML =
	"<html style='height:100%'><head>Incapsula challenge</head></html>";

const FTP: SymbolSource = {
	nasdaqUrl: "ftp://ftp.example.test/symboldirectory/nasdaqlisted.txt",
	otherUrl: "ftp://ftp.example.test/symboldirectory/otherlisted.txt",
};
const HTTPS: SymbolSource = {
	nasdaqUrl: "https://example.test/nasdaqlisted.txt",
	otherUrl: "https://example.test/otherlisted.txt",
};

/** Makes the mocked FTP client "download" `files[remotePath]` into the supplied writable. */
function ftpServes(files: Record<string, string>) {
	ftp.downloadTo.mockImplementation(
		async (sink: NodeJS.WritableStream, remote: string) => {
			const text = files[remote];
			if (text === undefined) throw new Error(`550 ${remote}: no such file`);
			sink.write(Buffer.from(text));
		},
	);
}

const httpServes = (nasdaq: string, other: string) =>
	vi.mocked(corelib.endPoints).mockResolvedValue([
		{ status: "success", value: { body: nasdaq } },
		{ status: "success", value: { body: other } },
	] as never);

beforeEach(() => {
	vi.clearAllMocks();
	ftp.access.mockResolvedValue(undefined);
	ftp.close.mockReturnValue(undefined);
});

describe("assertSymbolFile", () => {
	it("accepts each real header, a UTF-8 BOM and leading blank lines", () => {
		expect(() =>
			assertSymbolFile(NASDAQ_FILE, NASDAQ_LISTED_HEADER, "u"),
		).not.toThrow();
		expect(() =>
			assertSymbolFile(OTHER_FILE, OTHER_LISTED_HEADER, "u"),
		).not.toThrow();
		expect(() =>
			assertSymbolFile(`﻿\n${NASDAQ_FILE}`, NASDAQ_LISTED_HEADER, "u"),
		).not.toThrow();
	});

	it("rejects an HTML page, an empty body and near-miss headers", () => {
		for (const bad of [
			HTML,
			"",
			"Symbol|Name|x", // wrong second column
			"symbol|Security Name|x", // wrong case
		]) {
			expect(() =>
				assertSymbolFile(bad, NASDAQ_LISTED_HEADER, "the-url"),
			).toThrow(/the-url did not return a symbol directory file/);
		}
	});

	it("does not let one file pass for the other (nasdaqlisted vs otherlisted)", () => {
		expect(() =>
			assertSymbolFile(OTHER_FILE, NASDAQ_LISTED_HEADER, "u"),
		).toThrow(/did not return a symbol directory file/);
		expect(() =>
			assertSymbolFile(NASDAQ_FILE, OTHER_LISTED_HEADER, "u"),
		).toThrow(/did not return a symbol directory file/);
	});
});

describe("fetchSymbolFiles", () => {
	it("downloads both files over ONE anonymous FTP connection, one after the other", async () => {
		ftpServes({
			"/symboldirectory/nasdaqlisted.txt": NASDAQ_FILE,
			"/symboldirectory/otherlisted.txt": OTHER_FILE,
		});

		const result = await fetchSymbolFiles([FTP, HTTPS], 7_000);

		expect(result).toEqual({
			status: "success",
			nasdaqText: NASDAQ_FILE,
			otherText: OTHER_FILE,
		});
		expect(ftp.constructed).toHaveBeenCalledTimes(1);
		expect(ftp.constructed).toHaveBeenCalledWith(7_000);
		expect(ftp.access).toHaveBeenCalledTimes(1);
		expect(ftp.access).toHaveBeenCalledWith({
			host: "ftp.example.test",
			port: 21,
			user: "anonymous",
			password: "anonymous@",
			secure: false,
		});
		expect(ftp.downloadTo.mock.calls.map((c) => c[1])).toEqual([
			"/symboldirectory/nasdaqlisted.txt",
			"/symboldirectory/otherlisted.txt",
		]);
		expect(ftp.close).toHaveBeenCalledTimes(1);
		expect(corelib.endPoints).not.toHaveBeenCalled(); // fallback untouched when FTP works
	});

	it("falls back to HTTPS when the FTP connection fails, and still closes the client", async () => {
		ftp.access.mockRejectedValue(new Error("connect ETIMEDOUT"));
		httpServes(NASDAQ_FILE, OTHER_FILE);

		const result = await fetchSymbolFiles([FTP, HTTPS]);

		expect(result.status).toBe("success");
		expect(ftp.close).toHaveBeenCalledTimes(1);
		expect(vi.mocked(corelib.endPoints).mock.calls[0]?.[0]).toEqual([
			HTTPS.nasdaqUrl,
			HTTPS.otherUrl,
		]);
	});

	it("treats an HTML page from FTP as a failed source and uses the next one", async () => {
		ftpServes({
			"/symboldirectory/nasdaqlisted.txt": HTML,
			"/symboldirectory/otherlisted.txt": HTML,
		});
		httpServes(NASDAQ_FILE, OTHER_FILE);

		const result = await fetchSymbolFiles([FTP, HTTPS]);

		expect(result).toEqual({
			status: "success",
			nasdaqText: NASDAQ_FILE,
			otherText: OTHER_FILE,
		});
		expect(corelib.endPoints).toHaveBeenCalledTimes(1);
	});

	it("rejects a source whose SECOND file is wrong even though the first is fine", async () => {
		ftpServes({
			"/symboldirectory/nasdaqlisted.txt": NASDAQ_FILE,
			"/symboldirectory/otherlisted.txt": NASDAQ_FILE, // wrong file under the right name
		});
		httpServes(NASDAQ_FILE, OTHER_FILE);

		const result = await fetchSymbolFiles([FTP, HTTPS]);

		expect(result.status).toBe("success");
		expect(corelib.endPoints).toHaveBeenCalledTimes(1); // FTP source was rejected as a whole
	});

	it("names every source and its reason when all of them fail", async () => {
		ftp.access.mockRejectedValue(new Error("connect ECONNREFUSED"));
		httpServes(HTML, HTML);

		const result = await fetchSymbolFiles([FTP, HTTPS]);

		expect(result.status).toBe("error");
		if (result.status !== "error") return;
		expect(result.reason.message).toContain("connect ECONNREFUSED");
		expect(result.reason.message).toContain(HTTPS.nasdaqUrl);
		expect(result.reason.failures).toHaveLength(2);
	});

	it("reports a failed HTTPS result instead of treating its absent body as a file", async () => {
		vi.mocked(corelib.endPoints).mockResolvedValue([
			{ status: "error", reason: { message: "HTTP 503" } },
			{ status: "success", value: { body: OTHER_FILE } },
		] as never);

		const result = await fetchSymbolFiles([HTTPS]);

		expect(result.status).toBe("error");
		if (result.status !== "error") return;
		expect(result.reason.message).toContain("HTTP 503");
	});

	it("returns an error when no source is configured", async () => {
		const result = await fetchSymbolFiles([]);
		expect(result.status).toBe("error");
	});
});
