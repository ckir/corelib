"use strict";

/**
 * This example shows how to use the Alpaca Data V2 websocket to subscribe to events.
 * The socket is available under the `data_steam_v2` property on an Alpaca instance.
 * There are separate functions for subscribing (and unsubscribing) to trades, quotes and bars as seen below.
 */

const Alpaca = require("@alpacahq/alpaca-trade-api");
const APCA_API_KEY_ID = process.env.APCA_API_KEY_ID;
const APCA_API_SECRET_KEY = process.env.APCA_API_SECRET_KEY;

const alpaca = new Alpaca({
  keyId: APCA_API_KEY_ID,
  secretKey: APCA_API_SECRET_KEY,
  paper: true,
})

const websocket = alpaca.data_stream_v2;
websocket.onConnect(() => {
  websocket.subscribeForTrades(["AAPL", "MSFT", "TSLA", "GOOG", "AMZN"]);
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
