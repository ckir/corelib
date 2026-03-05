// =============================================
// FILE: ts-core/src/cli/impementations/node.ts
// PURPOSE: Node-specific CLI entry
// UPDATED: awaits async setupCommonCli
// =============================================

import { loadEnv, setupCommonCli } from "../common";

export default async function start() {
	const env = await loadEnv();
	console.log(`[Node] Loaded env → PLATFORM=${env.PLATFORM}`);
	await setupCommonCli();
}
