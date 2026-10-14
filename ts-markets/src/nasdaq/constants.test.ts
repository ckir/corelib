import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getNasdaqHeaders } from "./ApiNasdaqUnlimited";
import { CnnFearAndGreed } from "./CnnFearAndGreed";
import { DEFAULT_CHROME_VERSION } from "./constants";

let cnnUserAgent = "";
const server = setupServer(
	http.get("https://production.dataviz.cnn.io/*", ({ request }) => {
		cnnUserAgent = request.headers.get("user-agent") ?? "";
		return HttpResponse.json({ fear_and_greed: { score: 1 } });
	}),
);

describe("shared Chrome version default", () => {
	beforeAll(() => server.listen());
	afterAll(() => server.close());

	it("is 146", () => {
		expect(DEFAULT_CHROME_VERSION).toBe("146");
	});

	it("is used by the Nasdaq headers", () => {
		const ua = getNasdaqHeaders("https://api.nasdaq.com/x")["user-agent"];
		expect(ua).toContain(`Chrome/${DEFAULT_CHROME_VERSION}.0.0.0`);
	});

	it("is used by the CNN headers", async () => {
		await CnnFearAndGreed.getFearAndGreed("Historical");
		expect(cnnUserAgent).toContain(`Chrome/${DEFAULT_CHROME_VERSION}.0.0.0`);
	});
});
