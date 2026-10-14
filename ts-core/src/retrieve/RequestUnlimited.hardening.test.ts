// =============================================
// FILE: ts-core/src/retrieve/RequestUnlimited.hardening.test.ts
// PURPOSE: Pins hook pass-through, header normalisation, never-throws contract
// and URL redaction in warn logs for RequestUnlimited.endPoint.
// =============================================

import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const { mockLogger, mockChild } = vi.hoisted(() => {
	const child = {
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		fatal: vi.fn(),
	};
	const base = { ...child, child: vi.fn(() => child) };
	return { mockLogger: base, mockChild: child };
});
vi.mock("../loggers", () => ({ default: mockLogger }));

import { endPoint } from "./RequestUnlimited";

let seenHeaders: Headers | undefined;
const server = setupServer(
	http.get("https://api.test.com/ok", ({ request }) => {
		seenHeaders = request.headers;
		return HttpResponse.json({ ok: true });
	}),
	http.get("https://api.test.com/missing", () => {
		return new HttpResponse(null, { status: 404 });
	}),
);

describe("RequestUnlimited hardening", () => {
	beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
	afterAll(() => server.close());
	afterEach(() => {
		seenHeaders = undefined;
		vi.clearAllMocks();
	});

	it("passes caller afterResponse / beforeRequest hooks through to ky", async () => {
		const afterResponse = vi.fn();
		const beforeRequest = vi.fn();
		const result = await endPoint("https://api.test.com/ok", {
			hooks: { afterResponse: [afterResponse], beforeRequest: [beforeRequest] },
		});
		expect(result.status).toBe("success");
		expect(afterResponse).toHaveBeenCalledTimes(1);
		expect(beforeRequest).toHaveBeenCalledTimes(1);
	});

	it("normalises a Headers instance to lower-case keys", async () => {
		await endPoint("https://api.test.com/ok", {
			headers: new Headers({ Authorization: "x" }),
		});
		expect(seenHeaders?.get("authorization")).toBe("x");
	});

	it("normalises a [string,string][] header array", async () => {
		await endPoint("https://api.test.com/ok", {
			headers: [["Authorization", "x"]],
		});
		expect(seenHeaders?.get("authorization")).toBe("x");
	});

	it("still handles plain-object headers (and drops undefined values)", async () => {
		await endPoint("https://api.test.com/ok", {
			headers: { "X-Test": "1", "X-Skip": undefined } as unknown as Record<
				string,
				string
			>,
		});
		expect(seenHeaders?.get("x-test")).toBe("1");
		expect(seenHeaders?.has("x-skip")).toBe(false);
	});

	it.each([
		["undefined", undefined],
		["null", null],
		["a string", "boom"],
	])(
		"returns status:error (never throws) when fetch rejects with %s",
		async (_n, rejection) => {
			const result = await endPoint("https://api.test.com/ok", {
				retry: { limit: 0 },
				fetch: () => Promise.reject(rejection),
			});
			expect(result.status).toBe("error");
		},
	);

	it("does not leak query secrets in the HTTP Error warn log", async () => {
		const result = await endPoint(
			"https://api.test.com/missing?api_key=SECRET",
			{ retry: { limit: 0 } },
		);
		expect(result.status).toBe("error");
		expect(mockChild.warn).toHaveBeenCalled();
		const logged = JSON.stringify(mockChild.warn.mock.calls);
		expect(logged).not.toContain("SECRET");
	});
});
