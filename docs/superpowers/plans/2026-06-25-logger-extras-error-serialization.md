# Auto-Serialize Errors in Logger `extras` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared, deep, cycle-safe `normalizeExtras` helper that serializes `Error` instances anywhere in a `StrictLogger`'s `extras`, and wire it into all three `extras`-spread sites.

**Architecture:** One pure helper (`ts-core/src/loggers/common/normalize-extras.ts`) deep-clones `extras`, replacing every detected `Error` (in plain objects and arrays, at any depth) with `serializeError(err)`, cycle-safe via a `Map` memo. It is applied at the Pino `StrictLoggerWrapper` and the two bespoke spreaders (`CloudflareLogger`, `BrowserLogger`). No change to `validate()`, the `StrictLogger` interface, or method signatures.

**Tech Stack:** TypeScript, Vitest, `serialize-error@^13.0.1` (already a `ts-core` dependency), pnpm workspace, Biome, lefthook pre-commit.

**Spec:** `docs/superpowers/specs/2026-06-25-logger-extras-error-serialization-design.md`

**Gate commands:**
- Targeted tests: `pnpm -C ts-core exec vitest run <file…>`
- Full ts-core tests: `pnpm -C ts-core test:run`
- Fast gate (format + lint + typecheck): `pnpm verify:fast`

---

### Task 1: `normalizeExtras` helper (TDD)

**Files:**
- Create: `ts-core/src/loggers/common/normalize-extras.ts`
- Test: `ts-core/src/loggers/common/normalize-extras.test.ts`

- [ ] **Step 1: Write the failing unit test**

Create `ts-core/src/loggers/common/normalize-extras.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { serializeError } from "serialize-error";
import { normalizeExtras } from "./normalize-extras";

describe("normalizeExtras", () => {
	it("returns undefined for undefined", () => {
		expect(normalizeExtras(undefined)).toBeUndefined();
	});

	it("serializes a top-level Error value, preserving the key", () => {
		const out = normalizeExtras({ error: new Error("boom") }) as Record<
			string,
			any
		>;
		expect(out.error).toMatchObject({ name: "Error", message: "boom" });
		expect(typeof out.error.stack).toBe("string");
	});

	it("serializes an Error nested in a plain object", () => {
		const out = normalizeExtras({ a: { b: new Error("deep") } }) as any;
		expect(out.a.b).toMatchObject({ message: "deep" });
	});

	it("serializes an Error nested in an array", () => {
		const out = normalizeExtras({ list: [new Error("inarr")] }) as any;
		expect(out.list[0]).toMatchObject({ message: "inarr" });
	});

	it("wraps extras that is itself an Error under the `err` key", () => {
		const out = normalizeExtras(new Error("whole")) as any;
		expect(out.err).toMatchObject({ name: "Error", message: "whole" });
	});

	it("does not hang on a cyclic structure", () => {
		const o: Record<string, unknown> = { name: "cycle" };
		o.self = o;
		const out = normalizeExtras(o) as any;
		expect(out.name).toBe("cycle");
		expect(out.self).toBe(out); // cycle preserved, not infinite
	});

	it("leaves an already-serialized error object unchanged (idempotent)", () => {
		const pre = { error: serializeError(new Error("pre")) };
		const out = normalizeExtras(pre) as any;
		expect(out.error).toMatchObject({ message: "pre" });
		expect(out.error.name).toBe("Error");
	});

	it("preserves non-error values", () => {
		const date = new Date("2020-01-01T00:00:00Z");
		const out = normalizeExtras({ s: "x", n: 1, b: true, d: date }) as any;
		expect(out.s).toBe("x");
		expect(out.n).toBe(1);
		expect(out.b).toBe(true);
		expect(out.d).toBe(date); // non-plain object passed through by reference
	});

	it("serializes a cross-realm error (tagged [object Error])", () => {
		const fake = { message: "xrealm" };
		Object.defineProperty(fake, Symbol.toStringTag, { value: "Error" });
		const out = normalizeExtras({ e: fake }) as any;
		expect(out.e).toMatchObject({ message: "xrealm" });
	});

	it("does not mutate the caller's object", () => {
		const err = new Error("orig");
		const input = { error: err };
		normalizeExtras(input);
		expect(input.error).toBe(err); // still the original Error instance
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C ts-core exec vitest run src/loggers/common/normalize-extras.test.ts`
Expected: FAIL — `Failed to resolve import "./normalize-extras"` (module does not exist yet).

- [ ] **Step 3: Implement the helper**

Create `ts-core/src/loggers/common/normalize-extras.ts`:

```ts
// ts-core/src/loggers/common/normalize-extras.ts
// Deep, cycle-safe serialization of Error instances found anywhere in a
// logger's `extras` object. Pure: never mutates the input.
import { serializeError } from "serialize-error";

/** True for Error instances, including cross-realm errors that fail instanceof. */
function isError(value: unknown): boolean {
	return (
		value instanceof Error ||
		Object.prototype.toString.call(value) === "[object Error]"
	);
}

/** True only for plain objects (prototype Object.prototype or null). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * Deep-clone `extras`, replacing any Error (at any depth, inside plain objects
 * and arrays) with `serializeError()`. Non-plain objects (Date, Map, class
 * instances, etc.) are passed through by reference, untouched. Cycle-safe.
 *
 * @param extras - The caller-supplied extras (post-validate: undefined, a
 *   non-null non-array object, or — via type-bypass — an Error).
 * @returns A normalized object safe to spread into a log record, or undefined.
 */
export function normalizeExtras(
	extras: unknown,
): Record<string, unknown> | undefined {
	if (extras === undefined) return undefined;
	if (isError(extras)) {
		return { err: serializeError(extras) };
	}

	const seen = new Map<object, unknown>();
	const walk = (value: unknown): unknown => {
		if (isError(value)) return serializeError(value);

		if (Array.isArray(value)) {
			const existing = seen.get(value);
			if (existing) return existing;
			const clone: unknown[] = [];
			seen.set(value, clone);
			for (const item of value) clone.push(walk(item));
			return clone;
		}

		if (isPlainObject(value)) {
			const existing = seen.get(value);
			if (existing) return existing;
			const clone: Record<string, unknown> = {};
			seen.set(value, clone);
			for (const [k, v] of Object.entries(value)) clone[k] = walk(v);
			return clone;
		}

		return value;
	};

	return walk(extras) as Record<string, unknown>;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -C ts-core exec vitest run src/loggers/common/normalize-extras.test.ts`
Expected: PASS (all 10 cases green).

- [ ] **Step 5: Commit**

```bash
git add ts-core/src/loggers/common/normalize-extras.ts ts-core/src/loggers/common/normalize-extras.test.ts
git commit -m "feat(loggers): add deep cycle-safe normalizeExtras helper"
```

(lefthook runs Biome format/lint + clippy ~30s. A pre-existing unrelated WARNING about unused `mockDebug` in `src/core/index.test.ts` is NOT yours — ignore it; it does not block the commit.)

---

### Task 2: Wire the helper into all three spread sites + integration tests

**Files:**
- Modify: `ts-core/src/loggers/common/index.ts` (import after line 4; 6 spread sites at lines ~142, 149, 156, 163, 170, 177)
- Modify: `ts-core/src/loggers/implementations/cloudflare.ts` (import after line 4; spread at line 62)
- Modify: `ts-core/src/loggers/implementations/browser.ts` (add import; spread at line 49)
- Test: `ts-core/src/loggers/error-serialization.test.ts` (new)

- [ ] **Step 1: Write the failing integration test**

Create `ts-core/src/loggers/error-serialization.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { StrictLoggerWrapper } from "./common";
import createCloudflareLogger from "./implementations/cloudflare";
import browserLogger from "./implementations/browser";

describe("logger extras error serialization (wiring)", () => {
	it("Pino StrictLoggerWrapper serializes an Error in extras", () => {
		const calls: any[] = [];
		// minimal fake pino: only the .error sink is exercised here
		const fakePino: any = { error: (obj: unknown) => calls.push(obj) };
		const log = new StrictLoggerWrapper(fakePino);

		log.error("boom", { err: new Error("kaboom") });

		expect(calls).toHaveLength(1);
		expect(calls[0].err).toMatchObject({ message: "kaboom" });
		expect(typeof calls[0].err.stack).toBe("string");
	});

	it("CloudflareLogger serializes an Error in extras", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const log = createCloudflareLogger();

		log.error("boom", { err: new Error("kaboom") });

		const payload = JSON.parse(spy.mock.calls[0][0] as string);
		expect(payload.err).toMatchObject({ message: "kaboom" });
		spy.mockRestore();
	});

	it("BrowserLogger serializes an Error in extras", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});

		browserLogger.error("boom", { err: new Error("kaboom") });

		// emit -> consoleFn(`[ERROR]`, msg, { ...ctx, ...normalizeExtras(extras) })
		const merged = spy.mock.calls[0][2] as any;
		expect(merged.err).toMatchObject({ message: "kaboom" });
		spy.mockRestore();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C ts-core exec vitest run src/loggers/error-serialization.test.ts`
Expected: FAIL — the raw `Error` spreads to `{}`, so `calls[0].err` / `payload.err` / `merged.err` is `{}` and `.message` is undefined (assertions fail). Wiring is not yet in place.

- [ ] **Step 3: Wire `StrictLoggerWrapper`**

In `ts-core/src/loggers/common/index.ts`, add the import directly after line 4 (`import { getSysInfo } from "../../utils/SysInfo";`):

```ts
import { normalizeExtras } from "./normalize-extras";
```

Then in each of the six log methods (`trace`, `debug`, `info`, `warn`, `error`, `fatal`), change the spread argument from `...extras` to `...normalizeExtras(extras)`. Each call currently reads:

```ts
		this.pinoInstance.<level>(
			{ ...this.context, ...extras, telemetry: this.getTelemetry() },
			msg,
		);
```

and becomes:

```ts
		this.pinoInstance.<level>(
			{ ...this.context, ...normalizeExtras(extras), telemetry: this.getTelemetry() },
			msg,
		);
```

(Replace `...extras` with `...normalizeExtras(extras)` in all six methods. Do not change anything else.)

- [ ] **Step 4: Wire `CloudflareLogger`**

In `ts-core/src/loggers/implementations/cloudflare.ts`, add the import directly after line 4 (`import type { StrictLogger } from "../common";`):

```ts
import { normalizeExtras } from "../common/normalize-extras";
```

Then change line 62 inside `log()` from `...extras,` to:

```ts
			...normalizeExtras(extras),
```

- [ ] **Step 5: Wire `BrowserLogger`**

In `ts-core/src/loggers/implementations/browser.ts`, add an import after line 2 (`import type { StrictLogger } from "../common/index.js";`):

```ts
import { normalizeExtras } from "../common/normalize-extras.js";
```

Then change line 49 inside `emit()` from:

```ts
		consoleFn(`[${lvl.toUpperCase()}]`, msg, { ...this.ctx, ...extras });
```

to:

```ts
		consoleFn(`[${lvl.toUpperCase()}]`, msg, {
			...this.ctx,
			...normalizeExtras(extras),
		});
```

- [ ] **Step 6: Run the integration test to verify it passes**

Run: `pnpm -C ts-core exec vitest run src/loggers/error-serialization.test.ts`
Expected: PASS (all three wiring cases green).

- [ ] **Step 7: Run the existing logger suites to confirm no regression**

Run: `pnpm -C ts-core exec vitest run src/loggers/index.test.ts src/loggers/implementations/browser.test.ts`
Expected: PASS (existing behavior unchanged — already-serialized and non-error extras are untouched).

- [ ] **Step 8: Commit**

```bash
git add ts-core/src/loggers/common/index.ts ts-core/src/loggers/implementations/cloudflare.ts ts-core/src/loggers/implementations/browser.ts ts-core/src/loggers/error-serialization.test.ts
git commit -m "feat(loggers): auto-serialize Errors in extras at all spread sites"
```

---

### Task 3: Docs update + full-gate verification

**Files:**
- Modify: `AGENTS.md` (line 15)

- [ ] **Step 1: Update the logging convention in `AGENTS.md`**

In `AGENTS.md`, replace line 15:

```
    - Raw `Error` objects placed in `extras` must first be serialized via `serializeError()`.
```

with:

```
    - Raw `Error` objects placed in `extras` are **automatically** serialized by the logger (deep, cycle-safe, via `serialize-error`); an explicit `serializeError()` call is optional and remains a harmless no-op.
```

Leave line 14 (the structured-keys example) unchanged.

- [ ] **Step 2: Run the fast gate**

Run: `pnpm verify:fast`
Expected: PASS — Biome format/lint clean (aside from the pre-existing `mockDebug` warning) and `typecheck-all` reports no errors across the workspace.

- [ ] **Step 3: Run the full ts-core test suite**

Run: `pnpm -C ts-core test:run`
Expected: PASS — entire `ts-core` Vitest suite green (new helper + wiring + integration tests + all prior tests).

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md
git commit -m "docs: extras Errors are now auto-serialized by the logger"
```

---

## Self-Review

**Spec coverage:**
- Spec §"Architecture" (one helper, three sites) → Task 1 (helper) + Task 2 (three wirings). ✓
- Spec §"`normalizeExtras` contract" (undefined→undefined; extras-is-Error→`{err}`; `isError` instanceof+toString; serialize-and-stop; recurse plain objects+arrays only; non-plain passthrough; cycle-safe Map memo; no mutation) → Task 1 implementation + each is covered by a named unit test. ✓
- Spec §"Backward compatibility" (idempotent with existing `serializeError` call sites) → Task 1 "already-serialized … unchanged" test + Task 2 Step 7 regression run. ✓
- Spec §"Testing" (unit cases + per-path integration + regression + gate) → Task 1 unit file, Task 2 integration file (all 3 paths), Task 2 Step 7 regression, Task 3 full gate. ✓
- Spec §"Docs" (AGENTS.md 14-15) → Task 3 Step 1. ✓
- Spec §"Non-goals" (no context/telemetry normalization; no validate()/interface/signature changes; non-plain instances not recursed) → honored; no task touches `validate()`, the interface, or `context`/`telemetry`. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows complete paste-ready code; every run step has an expected result. ✓

**Type consistency:** `normalizeExtras` signature (`(extras: unknown) => Record<string, unknown> | undefined`), `isError`, `isPlainObject`, and the `err` key are spelled identically in the helper, the unit tests, and the wiring edits. The three call sites all invoke `normalizeExtras(extras)`. Imports use the correct relative paths and the `.js` ESM suffix in `browser.ts` (matching its existing `../common/index.js` import style). ✓
