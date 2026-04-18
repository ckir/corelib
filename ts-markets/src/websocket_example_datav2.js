"use strict";

/**
 * This example shows how to use the Alpaca Data V2 websocket to subscribe to events.
 * The socket is available under the `data_steam_v2` property on an Alpaca instance.
 * There are separate functions for subscribing (and unsubscribing) to trades, quotes and bars as seen below.
 */

const Alpaca = require("@alpacahq/alpaca-trade-api");
const API_KEY = "PKSAHT3YV5RKVEWKPGFTYBATUA";
const API_SECRET = "ChVNyuANVCwuwLAxaaJvxTNMRYQ82LvKZS53mvj6KYxk";

const alpaca = new Alpaca({
  keyId: API_KEY,
  secretKey: API_SECRET,
  paper: true,
})

const websocket = alpaca.data_stream_v2;
websocket.onConnect(() => {
  websocket.subscribeForQuotes(["AAPL", "MSFT", "TSLA", "GOOG", "AMZN"]);
});
websocket.onStateChange((status) => {
  console.log("Status:", status);
});
websocket.onError((err) => {
  console.log("Error:", err);
});
websocket.onStockQuote((trade) => {
  console.log("Quote:", trade);
});
websocket.connect();
