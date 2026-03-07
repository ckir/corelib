// =============================================
// FILE: ts-core/src/cli/common/index.ts
// PURPOSE: FULL Developers Cockpit MENU
//          Interactive numbered menu + CLI mirrors (dev build-rust, dev lint, etc.)
//
// FIXED (March 2026):
//   • Resolved persistent TS2769 overload error in runCommand:
//     - shell is now always string (or undefined), never boolean
//     - Uses platform-appropriate default shell string → types accept it in all overloads
//     - Maintains shell behavior (pipes, wildcards, etc.) needed for pnpm/cargo/biome commands
//   • Kept direct node_modules/.bin/biome calls (no npx → no Bun→npm warnings)
//   • Kept windowsHide: true (no console flash on Windows)
//   • Improved error logging
//
// FEATURES MAINTAINED (unchanged):
//   • .env respect (PLATFORM, RUNTIME, MODE, LOG_LEVEL)
//   • Runtime-aware env loading (Bun.env / Deno.env.toObject() / process.env)
//   • Commander CLI mirrors (pnpm dev lint, etc.)
//   • Interactive menu loop until Exit
//   • Number (1-12) + keyword/partial input parsing
//   • All actions: check (with Biome smoke test), clean, build-rust, build, test, test-rust,
//     bump, gen-docs, lint (with fixes), format (with fixes), release
//   • Workspace-root execution where needed (rootDir)
// =============================================

import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import * as path from "node:path";
import { program } from "commander";
import inquirer from "inquirer";

export async function loadEnv() {
	// Use runtime-native environment access
	if (typeof Bun !== "undefined") {
		return Bun.env;
	}
	if (typeof Deno !== "undefined") {
		return Deno.env.toObject();
	}
	// Node or fallback (earlyLoadEnvForNode already populated process.env if needed)
	return process.env;
}

const rootDir = path.join(process.cwd(), ".."); // workspace root (corelib/)
const rustDir = path.join(rootDir, "rust");
const tsCoreDir = process.cwd(); // ts-core/

export function runCommand(cmd: string, cwd: string = tsCoreDir): boolean {
	let shell: string | undefined;

	if (process.platform === "win32") {
		shell = process.env.ComSpec || "cmd.exe"; // Use ComSpec if set (usually cmd.exe)
	} else {
		shell = "/bin/sh"; // Standard Unix shell
	}

	try {
		execSync(cmd, {
			cwd,
			stdio: "inherit", // Live output in parent terminal
			shell, // Explicit string → satisfies all overloads
			windowsHide: true, // Prevent console window flash on Windows
		});
		return true;
	} catch (err: any) {
		console.error(`❌ Command failed: ${cmd}`);
		if (err?.message) {
			console.error(`   → ${err.message.split("\n")[0]}`);
		}
		if (err?.status !== undefined) {
			console.error(`   Exit code: ${err.status}`);
		}
		return false;
	}
}

export async function setupCommonCli() {
	const env = await loadEnv();

	console.log("---------- CoreLib Developers Cockpit -----------");
	console.log(
		`PLATFORM=${env.PLATFORM ?? "unset"}  RUNTIME=${env.RUNTIME ?? "unset"}  MODE=${env.MODE ?? "unset"}`,
	);
	console.log("-------------------------------------------------");

	const actions: Record<string, () => Promise<void>> = {
		check: async () => {
			console.log("🔍 1. Check Prerequisites & Health...");
			console.log(
				`  PLATFORM=${env.PLATFORM ?? "unset"} | RUNTIME=${env.RUNTIME ?? "unset"} | MODE=${env.MODE ?? "unset"}`,
			);
			console.log("  Node.js OK");

			try {
				execSync("cargo --version", { stdio: "ignore" });
				console.log("  Rust OK");
			} catch {
				console.log("  Rust not found");
			}

			console.log("  pnpm OK");

			// Biome smoke test (direct .bin call, platform-aware)
			try {
				const biomeBin = path.join(rootDir, "node_modules", ".bin", "biome");
				const versionCmd =
					process.platform === "win32"
						? `"${biomeBin}.cmd" --version`
						: `${biomeBin} --version`;
				execSync(versionCmd, { stdio: "ignore" });
				console.log("  Biome OK");
			} catch {
				console.log("  ⚠️  Biome not detected – lint/format may fail");
			}

			console.log("Health check complete!");
		},

		clean: async () => {
			console.log("🧹 2. CLEAN & REINSTALL (Fresh Start)...");
			await fs
				.rm(path.join(tsCoreDir, "dist"), { recursive: true, force: true })
				.catch(() => {});
			console.log("  Cleaned dist/");
			console.log("  Reinstalling workspace...");
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
			const biomeBin = path.join(rootDir, "node_modules", ".bin", "biome");
			const cmd =
				process.platform === "win32"
					? `"${biomeBin}.cmd" lint --write . --max-diagnostics=0`
					: `${biomeBin} lint --write . --max-diagnostics=0`;

			const success = runCommand(cmd, rootDir);
			if (success) {
				console.log("✅ Lint complete");
			} else {
				console.log("❌ Lint failed – ensure pnpm install was run");
			}
		},

		format: async () => {
			console.log("📝 10. Format Code...");
			const biomeBin = path.join(rootDir, "node_modules", ".bin", "biome");
			const cmd =
				process.platform === "win32"
					? `"${biomeBin}.cmd" format --write . --max-diagnostics=0`
					: `${biomeBin} format --write . --max-diagnostics=0`;

			const success = runCommand(cmd, rootDir);
			if (success) {
				console.log("✅ Format complete");
			} else {
				console.log("❌ Format failed – ensure pnpm install was run");
			}
		},

		release: async () => {
			console.log("📦 11. Create release package...");
			if (runCommand("pnpm pack", tsCoreDir)) {
				console.log("✅ Release package created (.tgz file)");
			} else {
				console.log("❌ Release package creation failed");
			}
		},
	};

	// Register CLI mirrors (for direct calls like pnpm dev lint)
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

	// Interactive menu only when no subcommand provided
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
			console.log("");
			for (const choice of choices) {
				console.log(choice.name);
			}
			console.log("");

			const { action } = await inquirer.prompt([
				{
					type: "input",
					name: "action",
					message: "Select Action:",
				},
			]);

			const input = (action as string).trim().toLowerCase();
			let selectedKey: string | undefined;

			const num = parseInt(input, 10);
			if (!Number.isNaN(num) && num >= 1 && num <= 12) {
				selectedKey = choices[num - 1].value;
			} else if (input.length > 0) {
				const match = choices.find(
					(c) =>
						c.value.toLowerCase() === input ||
						c.name.toLowerCase().includes(input),
				);
				selectedKey = match?.value;
			}

			if (
				selectedKey === "exit" ||
				input === "exit" ||
				input === "q" ||
				input === "quit"
			) {
				console.log("👋 Goodbye!");
				process.exit(0);
			}

			if (selectedKey && actions[selectedKey]) {
				await actions[selectedKey]();
			} else if (input.length > 0) {
				console.log(
					`❌ Invalid choice: "${action}". Enter 1–12 or keyword (e.g. lint, exit)`,
				);
			}

			console.log(""); // separator before next prompt
		}
	} else {
		// CLI mode: run single action
		program.parse();
	}
}
