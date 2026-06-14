// Build-time constant: `true` only in the Cloudflare worker bundle (tsup `define`),
// `undefined` everywhere else. Gates Node-only dynamic imports for dead-code
// elimination. Declared as a global via a real module (not an ambient `.d.ts`) and
// side-effect-imported by its consumers, so the declaration travels with the import
// graph — it stays visible when ts-core sources are compiled from a dependent
// package (ts-cloud, ts-markets) via tsconfig path-mapping, not just inside ts-core.
declare global {
	const __EDGE_RUNTIME__: boolean | undefined;
}

export {};
