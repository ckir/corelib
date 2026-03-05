// =============================================
// FILE: ts-core/src/cli/impementations/bun.ts
// PURPOSE: Bun-specific CLI entry
// UPDATED: awaits async setupCommonCli
// =============================================

import { loadEnv, setupCommonCli } from "../common";

export default async function start() {
	const env = await loadEnv();
	console.log(`[Bun] Loaded env → PLATFORM=${env.PLATFORM}`);
	await setupCommonCli();
}
