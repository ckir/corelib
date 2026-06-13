// =============================================
// PROBE: boot-ConfigManager-cli-override-process-exit-07
// =============================================
// What the code CLAIMS: ConfigManager.initialize(args?) supports dynamic CLI
// overrides — applyCliOverrides() (ConfigManager.ts:391-418) maps any
// `--kebab-case value` / `--kebab-case=value` arg to a config path, and the
// program is configured with allowUnknownOption(true) (:170) precisely so
// unknown flags flow through to that override mechanism instead of being
// rejected. The doc comment on initialize() lists "Apply CLI Overrides" as
// step 5, and loadExternalConfig() (:215-216) references caching "the parsed
// program from initialize()" — i.e. arbitrary override flags are an intended
// public input.
//
// OBSERVED (this probe): under commander@15, parseAsync (:172) classifies an
// unknown long option as an EXCESS ARGUMENT and calls program.error(), whose
// default action is process.exit(1). allowUnknownOption(true) does NOT cover
// this case. So passing ANY override flag — the documented happy path — does
// not set config; it terminates the host process. A library bootstrap calling
// process.exit(1) on caller-supplied (or env/CLI-derived) input is a
// denial-of-service / crash hazard, and it makes the concurrent-init race
// (boot-ConfigManager-initialize-races-01) unreachable via the CLI path.
//
// Oracle: initialize(['--probeflag=x']) MUST resolve and set
// get('probeflag') === 'x' (or at minimum NOT exit the process). We assert the
// resolve+set guarantee; the bug reproduces deterministically on iter 0.
//
// Reads only; never writes production config. Deterministic, single iteration.
// =============================================

import { describe, expect, it } from "vitest";
import { ConfigManager } from "../../ts-core/src/configs/ConfigManager";

describe("ConfigManager CLI-override bootstrap contract", () => {
	// This probe is a regression guard for the fix: initialize() must resolve
	// and apply the override flag without ever calling process.exit.
	it("initialize() with an override flag applies it and never calls process.exit", async () => {
		const cm = ConfigManager.getInstance();

		// Trap process.exit so a library-triggered exit surfaces as a test failure
		// instead of tearing down the worker. Records whether/with-what it fired.
		const realExit = process.exit;
		let exitCalledWith: number | string | null | undefined = undefined;
		// @ts-expect-error overriding for the duration of the assertion
		process.exit = (code?: number | string | null) => {
			exitCalledWith = code;
			throw new Error(`process.exit(${code}) called`);
		};

		let resolved = false;
		let liveValue: unknown;
		let threw: unknown;
		try {
			await cm.initialize(["--probeflag=hello"]);
			resolved = true;
			liveValue = cm.get("probeflag");
		} catch (e) {
			threw = e;
		} finally {
			process.exit = realExit;
		}

		// FIXED-CONTRACT ORACLE (regression guard): initialize() must resolve,
		// must NOT have triggered process.exit, and must have applied the flag.
		void threw;
		expect(exitCalledWith).toBeUndefined();
		expect(resolved).toBe(true);
		expect(liveValue).toBe("hello");
	});
});
