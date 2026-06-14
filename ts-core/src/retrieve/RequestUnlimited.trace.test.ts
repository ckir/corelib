// =============================================
// FILE: ts-core/src/retrieve/RequestUnlimited.trace.test.ts
// PURPOSE: Golden-trace test — a retried request must log the full §12
// decision chain (open → per-attempt delay → close) so it is reconstructable
// from logs alone. RequestUnlimited logs via the internal "../loggers", so we
// mock that (NOT "@ckir/corelib").
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

const { mockTrace, mockDebug, mockLogger } = vi.hoisted(() => {
	const trace = vi.fn();
	const debug = vi.fn();
	const child = {
		trace,
		debug,
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		fatal: vi.fn(),
	};
	const base = {
		trace,
		debug,
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn(() => child),
	};
	return { mockTrace: trace, mockDebug: debug, mockLogger: base };
});
vi.mock("../loggers", () => ({ default: mockLogger }));

import { endPoint } from "./RequestUnlimited";

// A stateful handler: first attempt 500 (retryable) → forces one retry → then 200.
let attempts = 0;
const server = setupServer(
	http.get("https://api.test.com/golden", () => {
		attempts++;
		if (attempts < 2) return new HttpResponse(null, { status: 500 });
		return HttpResponse.json({ ok: true });
	}),
);

describe("RequestUnlimited trace completeness", () => {
	beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
	afterAll(() => server.close());
	afterEach(() => {
		server.resetHandlers();
		attempts = 0;
		vi.clearAllMocks();
	});

	it("a retried request logs the full decision chain at trace/debug", async () => {
		const result = await endPoint("https://api.test.com/golden");
		expect(result.status).toBe("success");

		const msgs = [...mockDebug.mock.calls, ...mockTrace.mock.calls].map(
			(c) => c[0],
		);
		expect(msgs).toContain("endPoint: request"); // open
		expect(msgs).toContain("retry delay computed"); // per-attempt trace (retry happened)
		expect(msgs).toContain("endPoint: ok"); // close
	});
});
