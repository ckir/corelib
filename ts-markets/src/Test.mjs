import yahooFinance from '@gadicc/yahoo-finance2';

// Shim Deno for the JSR version of yahoo-finance2 when running in Bun/Node
// This prevents "ReferenceError: Deno is not defined" during logging initialization.
if (typeof globalThis.Deno === 'undefined') {
	globalThis.Deno = {
		stdout: {
			isTerminal: () => true,
		},
	};
}

/**
 * Note: @gadicc/yahoo-finance2 (v3) can be used as a constructor or a default instance.
 * Here we instantiate it to allow passing options like suppressNotices.
 */
const yf = new yahooFinance({
	suppressNotices: ["yahooSurvey"],
});

// async function run() {
// 	try {
// 		// Use Promise.all to await all async quote requests.
// 		// Note: yahoo-finance2 automatically batches these into a single HTTP request when possible.
// 		const results = await Promise.all(
// 			symbols.map((symbol) => yf.quote(symbol, { fields })),
// 		);

// 		console.log("Quotes fetched successfully:");
// 		console.log(results);
// 	} catch (error) {
// 		console.error("Error fetching quotes:", error);
// 	}
// }

// run();

const databaseResults = [ "AAPL", "TSLA", "MSFT" ];
const fields = ["ask", "bid", "marketState"];

databaseResults.forEach(async (row) => {
  const result = await yf.quoteCombine(row, { fields:fields });
  console.log(result);
});
