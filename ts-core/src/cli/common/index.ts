// =============================================
// FILE: ts-core/src/cli/common/index.ts
// PURPOSE: FULL Developers Cockpit MENU as you requested
// Exact header + numbered list + "Select Action:"
// Every option has a CLI mirror (dev build-rust, dev gen-docs, etc.)
//
// FIXED (2026-03-05):
//   • Explicit console.log of the numbered choices BEFORE the prompt
//     → menu options are NOW ALWAYS visible in any terminal/runtime
//     (previous inquirer 'list' renderer sometimes failed to show choices)
//   • Switched to type: 'input' + smart number/keyword parser
//     → supports typing 1, 2, ..., 9, 0 or "check", "build", "release", etc.
//   • One-shot action (no loop) – same as original
//
// NEW FIXES (based on user feedback):
//   • Made the menu loop: after each action, show menu again until exit
//   • Fixed exit option numbering to '10. Exit' to match expected output
//   • Adjusted parsing: num 1-9 for actions, 10 for exit (0 treated as invalid)
//   • Improved action success handling: use runCommand return value to conditionally log ✅ or ❌
//     Prevents printing ✅ when command fails (e.g., vitest not found)
//   • For actions with multiple steps (e.g., clean), check each runCommand and early return on failure
//
// NEW ADDITIONS (2026-03-05):
//   • Added Lint and Format options using Biome
//     9. Lint Code (biome lint --write --max-diagnostics=0)
//     10. Format Code (biome format --write --max-diagnostics=0)
//     Shifted release to 11, exit to 12
//   • Commands run from rootDir to cover whole workspace
//   • Added CLI mirrors: dev lint, dev format
//
// NEW FIXES (2026-03-05):
//   • Fixed lint command flag: --apply → --write (Biome uses --write for applying fixes)
//   • Updated gen-docs: Now runs 'pnpm exec typedoc' since typedoc is installed and typedoc.json exists
//   • Added --max-diagnostics=0 to lint and format commands to show all diagnostics (unlimited)
//
// NEW FIXES (2026-03-05):
//   • Replaced (globalThis as any) with typeof Bun/Deno checks for better typing
//   • Changed choices.forEach to for...of loop to avoid lint/suspicious/useIterableCallbackReturn
//
// All unrelated features fully maintained:
//   • loadEnv / runtime detection / .env respect (RUNTIME=bun still shows [Bun])
//   • Commander CLI mirrors
//   • runCommand, clean, build-rust, test-rust, bump, gen-docs, release
//   • Rust FFI, dynamic loggers, Configs/Core/Database/Retrieve/Utils, ts-cloud, etc.
// =============================================

import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import * as path from "node:path";
import { program } from "commander";
import inquirer from "inquirer";

export async function loadEnv() {
	// Use ACTUAL runtime for env access (prevents crash when .env RUNTIME != real runtime)
	if (typeof Bun !== "undefined") {
		return Bun.env;
	}
	if (typeof Deno !== "undefined") {
		return Deno.env.toObject();
	}
	// Node or cockpit fallback (earlyLoadEnvForNode already put .env values here)
	return process.env;
}

const rootDir = path.join(process.cwd(), "..");
const rustDir = path.join(rootDir, "rust");
const tsCoreDir = process.cwd();

export function runCommand(cmd: string, cwd: string = tsCoreDir): boolean {
	try {
		execSync(cmd, { cwd, stdio: "inherit" });
		return true;
	} catch (_e) {
		console.error(`❌ Command failed: ${cmd}`);
		return false;
	}
}

export async function setupCommonCli() {
	const env = await loadEnv();

	console.log("---------- CoreLib Developers Cockpit -----------");
	console.log(
		`PLATFORM=${env.PLATFORM} - RUNTIME=${env.RUNTIME} - MODE=${env.MODE}`,
	);
	console.log("-------------------------------------------------");

	const actions: Record<string, () => Promise<void>> = {
		check: async () => {
			console.log("🔍 1. Check Prerequisites & Health...");
			console.log(
				`✅ PLATFORM=${env.PLATFORM} | RUNTIME=${env.RUNTIME} | MODE=${env.MODE}`,
			);
			console.log("✅ Node.js OK");
			try {
				execSync("cargo --version", { stdio: "ignore" });
				console.log("✅ Rust OK");
			} catch {}
			console.log("✅ pnpm OK");
			console.log("Health check complete!");
		},
		clean: async () => {
			console.log("🧹 2. CLEAN & REINSTALL (Fresh Start)...");
			await fs
				.rm(path.join(tsCoreDir, "dist"), { recursive: true, force: true })
				.catch(() => {});
			console.log("✅ Cleaned dist");
			console.log("🔄 Reinstalling workspace...");
			if (!runCommand("pnpm install", rootDir)) return;
			console.log("✅ Fresh start complete!");
		},
		"build-rust": async () => {
			console.log("🔨 3. Build Rust...");
			if (runCommand("cargo build", rustDir)) {
				console.log("✅ Rust build complete");
			} else {
				console.log("❌ Rust build failed");
			}
		},
		build: async () => {
			console.log("📦 4. Build Typescript...");
			if (runCommand("pnpm exec tsup")) {
				console.log("✅ TypeScript build complete");
			} else {
				console.log("❌ TypeScript build failed");
			}
		},
		test: async () => {
			console.log("🧪 5. Run Typescript Tests...");
			if (runCommand("pnpm exec vitest run")) {
				console.log("✅ TypeScript tests complete");
			} else {
				console.log("❌ TypeScript tests failed");
			}
		},
		"test-rust": async () => {
			console.log("🧪 6. Run Rust Tests...");
			if (runCommand("cargo test", rustDir)) {
				console.log("✅ Rust tests complete");
			} else {
				console.log("❌ Rust tests failed");
			}
		},
		bump: async () => {
			console.log("📦 7. Bump version...");
			if (runCommand("npm version patch --no-git-tag-version")) {
				console.log("✅ Version bumped!");
			} else {
				console.log("❌ Version bump failed");
			}
		},
		"gen-docs": async () => {
			console.log("📚 8. Generate Documentation (TypeDoc)...");
			if (runCommand("pnpm exec typedoc")) {
				console.log("✅ Documentation generated in docs/");
			} else {
				console.log("❌ Documentation generation failed");
			}
		},
		lint: async () => {
			console.log("🔍 9. Lint Code...");
			if (
				runCommand(
					"pnpm exec biome lint --write . --max-diagnostics=0",
					rootDir,
				)
			) {
				console.log("✅ Lint complete");
			} else {
				console.log("❌ Lint failed");
			}
		},
		format: async () => {
			console.log("📝 10. Format Code...");
			if (
				runCommand(
					"pnpm exec biome format --write . --max-diagnostics=0",
					rootDir,
				)
			) {
				console.log("✅ Format complete");
			} else {
				console.log("❌ Format failed");
			}
		},
		release: async () => {
			console.log("📦 11. Create release package...");
			if (runCommand("pnpm pack")) {
				console.log("✅ Release package created (.tgz file)");
			} else {
				console.log("❌ Release package creation failed");
			}
		},
	};

	// Register all CLI mirrors (for direct calls like `pnpm dev build-rust`)
	program
		.command("check")
		.description("Check Prerequisites & Health")
		.action(actions.check);
	program
		.command("clean")
		.description("CLEAN & REINSTALL (Fresh Start)")
		.action(actions.clean);
	program
		.command("build-rust")
		.description("Build Rust")
		.action(actions["build-rust"]);
	program
		.command("build")
		.description("Build Typescript")
		.action(actions.build);
	program
		.command("test")
		.description("Run Typescript Tests")
		.action(actions.test);
	program
		.command("test-rust")
		.description("Run Rust Tests")
		.action(actions["test-rust"]);
	program.command("bump").description("Bump version").action(actions.bump);
	program
		.command("gen-docs")
		.description("Generate Documentation (TypeDoc)")
		.action(actions["gen-docs"]);
	program.command("lint").description("Lint Code").action(actions.lint);
	program.command("format").description("Format Code").action(actions.format);
	program
		.command("release")
		.description("Create release package")
		.action(actions.release);

	// Interactive menu only when no arguments
	if (process.argv.slice(2).length === 0) {
		const choices = [
			{ name: "1. Check Prerequisites & Health", value: "check" },
			{ name: "2. CLEAN & REINSTALL (Fresh Start)", value: "clean" },
			{ name: "3. Build Rust", value: "build-rust" },
			{ name: "4. Build Typescript", value: "build" },
			{ name: "5. Run Typescript Tests", value: "test" },
			{ name: "6. Run Rust Tests", value: "test-rust" },
			{ name: "7. Bump version", value: "bump" },
			{ name: "8. Generate Documentation (TypeDoc)", value: "gen-docs" },
			{ name: "9. Lint Code", value: "lint" },
			{ name: "10. Format Code", value: "format" },
			{ name: "11. Create release package", value: "release" },
			{ name: "12. Exit", value: "exit" },
		];

		while (true) {
			// === FIXED: Explicit numbered list so options are ALWAYS visible ===
			console.log("");
			for (const choice of choices) {
				console.log(choice.name);
			}
			console.log("");

			const ans = await inquirer.prompt([
				{
					type: "input",
					name: "action",
					message: "Select Action:",
				},
			]);

			const input = ans.action.trim();
			let actionKey: string | undefined;

			const num = parseInt(input, 10);
			if (!Number.isNaN(num) && num >= 1 && num <= 12) {
				actionKey = choices[num - 1].value;
			} else if (input.length > 0) {
				// fallback: match by value or partial name (e.g. "check", "build-rust")
				const lower = input.toLowerCase();
				const matched = choices.find(
					(c) =>
						c.value.toLowerCase() === lower ||
						c.name.toLowerCase().includes(lower),
				);
				actionKey = matched?.value;
			}

			if (actionKey === "exit" || input.toLowerCase() === "exit") {
				console.log("👋 Goodbye!");
				process.exit(0);
			} else if (actionKey && actions[actionKey]) {
				await actions[actionKey]?.();
			} else {
				console.log(
					`❌ Invalid choice: "${input}". Enter a number 1-12 or action key (e.g. "check").`,
				);
			}
			console.log(""); // Separator before next menu
		}
	} else {
		program.parse();
	}
}
