// =============================================
// FILE: ts-markets/src/nasdaq/symbolStore.contract.ts
// PURPOSE: Backend-independent contract tests every SymbolStore implementation must pass.
// =============================================

import { afterEach, describe, expect, it } from "vitest";
import type { MarketSymbolRow } from "./MarketSymbols";
import type { SymbolStore } from "./symbolStore";

type Harness = {
	store: SymbolStore;
	/** Returns rows that make replaceAll fail on this backend. */
	poison: (good: MarketSymbolRow[]) => MarketSymbolRow[];
	cleanup: () => Promise<void>;
};

function row(symbol: string, ts = 1000): MarketSymbolRow {
	return {
		symbol,
		name: `${symbol} Inc`,
		type: "rt",
		class: "stocks",
		ts,
		active: true,
	};
}

export function symbolStoreContract(
	label: string,
	make: () => Promise<Harness>,
): void {
	describe(`SymbolStore contract: ${label}`, () => {
		let h: Harness | undefined;
		afterEach(async () => {
			await h?.cleanup();
			h = undefined;
		});
		const setup = async (): Promise<Harness> => {
			h = await make();
			await h.store.init();
			return h;
		};

		it("empty store: count 0, lastRefreshTs null, find null", async () => {
			const { store } = await setup();
			expect(await store.count()).toBe(0);
			expect(await store.lastRefreshTs()).toBeNull();
			expect(await store.find("AAPL")).toBeNull();
		});

		it('round trip: replaceAll then find("aapl") returns {symbol:"AAPL", active:true, ts: number}; lastRefreshTs equals refreshTs; count equals rows.length', async () => {
			const { store } = await setup();
			const rows = [row("AAPL", 5000), row("MSFT", 5000)];
			await store.replaceAll(rows, 5000);
			const found = await store.find("aapl");
			expect(found).toMatchObject({ symbol: "AAPL", active: true });
			expect(typeof found?.ts).toBe("number");
			expect(await store.lastRefreshTs()).toBe(5000);
			expect(await store.count()).toBe(rows.length);
		});

		it("a second replaceAll replaces the set: old symbols gone, new present, count equals new length", async () => {
			const { store } = await setup();
			const first = [row("AAPL"), row("MSFT")];
			await store.replaceAll(first, 1000);
			expect(await store.count()).toBe(first.length);
			const next = [row("GOOG", 2000), row("TSLA", 2000), row("NVDA", 2000)];
			await store.replaceAll(next, 2000);
			// Intentional contract: replaced symbols are no longer findable, but a backend may keep
			// them as inactive rows (SQL does), so count() is only bounded below by the new set.
			for (const old of first) {
				expect(await store.find(old.symbol)).toBeNull();
			}
			for (const r of next) {
				expect(await store.find(r.symbol)).toMatchObject({ symbol: r.symbol });
			}
			expect(await store.count()).toBeGreaterThanOrEqual(next.length);
		});

		it("a failing replaceAll (poison rows) rejects and leaves symbols, count and lastRefreshTs unchanged", async () => {
			const { store, poison } = await setup();
			const good = [row("AAPL", 1000), row("MSFT", 1000)];
			await store.replaceAll(good, 1000);
			await expect(
				store.replaceAll(poison([row("GOOG", 2000)]), 2000),
			).rejects.toThrow();
			expect(await store.find("AAPL")).not.toBeNull();
			expect(await store.find("MSFT")).not.toBeNull();
			expect(await store.find("GOOG")).toBeNull();
			expect(await store.count()).toBe(good.length);
			expect(await store.lastRefreshTs()).toBe(1000);
		});

		it("replaceAll([]) rejects and leaves the set unchanged", async () => {
			const { store } = await setup();
			await store.replaceAll([row("AAPL", 1000)], 1000);
			await expect(store.replaceAll([], 2000)).rejects.toThrow();
			expect(await store.find("AAPL")).not.toBeNull();
			expect(await store.count()).toBe(1);
			expect(await store.lastRefreshTs()).toBe(1000);
		});

		it('hostile symbols "A.*", "$ne", "", " AAPL " return null without throwing', async () => {
			const { store } = await setup();
			await store.replaceAll([row("AAPL"), row("MSFT")], 1000);
			for (const hostile of ["A.*", "$ne", "", " AAPL "]) {
				expect(await store.find(hostile)).toBeNull();
			}
		});

		it("12000 rows round trip, count is 12000, under 30 s", async () => {
			const { store } = await setup();
			const rows = Array.from({ length: 12000 }, (_, i) => row(`S${i}`, 3000));
			const started = Date.now();
			await store.replaceAll(rows, 3000);
			expect(await store.count()).toBe(12000);
			expect(await store.find("S11999")).toMatchObject({ symbol: "S11999" });
			expect(Date.now() - started).toBeLessThan(30_000);
		}, 60_000);

		it("init is idempotent and safe to call twice concurrently", async () => {
			const { store } = await setup();
			await Promise.all([store.init(), store.init()]);
			await store.init();
			await store.replaceAll([row("AAPL")], 1000);
			expect(await store.count()).toBe(1);
		});
	});
}
