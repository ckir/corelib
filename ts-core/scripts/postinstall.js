// =============================================
// FILE: ts-core/scripts/postinstall.js
// PURPOSE: Post-install script for downloading Rust binaries
// FIXED (2026-03-08): Skips download if MODE=development (local dev)
// =============================================

import { existsSync } from "node:fs";
import { resolve } from "node:path";

const MODE = process.env.MODE || "production";
const isDev = MODE === "development";

console.log(`[POSTINSTALL] Running in ${MODE} mode`);

if (isDev) {
	console.log("[POSTINSTALL] Local development mode detected. Skipping binary download.");
	process.exit(0);
}

// FUTURE: Implement logic to download pre-built binary from GitHub Releases
// Based on platform and arch (process.platform, process.arch)
console.log("[POSTINSTALL] Production mode: Placeholder for GitHub binary download.");
// Example: downloadFromGitHub(version, platform, arch)
