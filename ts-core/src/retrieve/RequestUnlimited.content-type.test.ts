// =============================================
// FILE: ts-core/src/retrieve/RequestUnlimited.content-type.test.ts
// PURPOSE: Pins the content-type behaviour of RequestUnlimited.endPoint: no blanket default (it broke
// FormData boundaries and made every GET non-simple for CORS), while JSON string bodies keep working.
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

const { mockLogger } = vi.hoisted(() => {
	const child = {
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		fatal: vi.fn(),
	};
	return { mockLogger: { ...child, child: vi.fn(() => child) } };
});
vi.mock("../loggers", () => ({ default: mockLogger }));

import { endPoint } from "./RequestUnlimited";

let seen: { contentType: string | null; accept: string | null } | undefined;
const record = (request: Request) => {
	seen = {
		contentType: request.headers.get("content-type"),
		accept: request.headers.get("accept"),
	};
};

const server = setupServer(
	http.get("https://api.test.com/echo", ({ request }) => {
		record(request);
		return HttpResponse.json({ ok: true });
	}),
	http.post("https://api.test.com/echo", async ({ request }) => {
		record(request);
		await request.arrayBuffer();
		return HttpResponse.json({ ok: true });
	}),
);

const post = (options: Record<string, unknown>) =>
	endPoint("https://api.test.com/echo", { method: "post", ...options });

describe("RequestUnlimited content-type", () => {
	beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
	afterAll(() => server.close());
	afterEach(() => {
		seen = undefined;
		vi.clearAllMocks();
	});

	it("sends no content-type on a body-less GET, but keeps the default accept header", async () => {
		const result = await endPoint("https://api.test.com/echo");
		expect(result.status).toBe("success");
		expect(seen?.contentType).toBeNull();
		expect(seen?.accept).toBe("application/json");
	});

	it("lets FormData set its own multipart content-type with a boundary", async () => {
		const form = new FormData();
		form.append("field", "value");
		const result = await post({ body: form });
		expect(result.status).toBe("success");
		expect(seen?.contentType).toMatch(/^multipart\/form-data; boundary=/);
	});

	it("lets URLSearchParams set its own form-urlencoded content-type", async () => {
		const result = await post({ body: new URLSearchParams({ a: "1" }) });
		expect(result.status).toBe("success");
		expect(seen?.contentType).toMatch(/^application\/x-www-form-urlencoded/);
	});

	it("sends application/json for the json option", async () => {
		const result = await post({ json: { a: 1 } });
		expect(result.status).toBe("success");
		expect(seen?.contentType).toMatch(/^application\/json/);
	});

	it("still defaults a JSON string body to application/json (back-compat)", async () => {
		const result = await post({ body: JSON.stringify({ a: 1 }) });
		expect(result.status).toBe("success");
		expect(seen?.contentType).toBe("application/json");
	});

	it("keeps a caller-supplied content-type on a string body, whatever its key casing", async () => {
		const result = await post({
			body: "plain text",
			headers: { "Content-Type": "text/plain" },
		});
		expect(result.status).toBe("success");
		expect(seen?.contentType).toBe("text/plain");
	});
});
