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
	// This probe REPRODUCES the defect: it passes while the bug is present
	// (initialize() exits the process on a documented override flag) and will
	// start FAILING once the bug is fixed (initialize resolves + applies the
	// flag). Treat a future failure of this test as "the bug got fixed — update
	// the oracle to the fixed contract below."
	it("REPRO: initialize() with an override flag triggers process.exit(1) instead of applying it", async () => {
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

		// REPRODUCTION ORACLE (bug present): initialize() must NOT have resolved,
		// must have triggered process.exit(1), and must not have applied the flag.
		// When the bug is fixed these three assertions will start failing — that
		// failure is the signal to flip this to the fixed-contract oracle:
		//   expect(exitCalledWith).toBeUndefined();
		//   expect(resolved).toBe(true);
		//   expect(liveValue).toBe("hello");
		void threw;
		expect(
			exitCalledWith,
			"bug fixed? initialize() no longer exits on an override flag — flip oracle",
		).toBe(1);
		expect(
			resolved,
			"bug fixed? initialize() resolved instead of crashing — flip oracle",
		).toBe(false);
		expect(
			liveValue,
			"bug fixed? override flag was applied — flip oracle",
		).toBeUndefined();
	});
});
