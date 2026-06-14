// Build-time constant: `true` only in the Cloudflare worker bundle (tsup `define`),
// `undefined` everywhere else. Gates Node-only dynamic imports for dead-code elimination.
declare const __EDGE_RUNTIME__: boolean | undefined;
