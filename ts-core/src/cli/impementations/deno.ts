// =============================================
// FILE: ts-core/src/cli/impementations/deno.ts
// PURPOSE: Deno-specific CLI entry
// UPDATED: awaits async setupCommonCli
// =============================================

import { loadEnv, setupCommonCli } from "../common";

export default async function start() {
	const env = await loadEnv();
	console.log(`[Deno] Loaded env → PLATFORM=${env.PLATFORM}`);
	await setupCommonCli();
}
