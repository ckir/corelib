# Remove Deprecated Wrapper Objects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the three `@deprecated` wrapper objects (`SysInfo`, `RequestUnlimited`, `RequestResponseSerialize`) from `ts-core` and migrate every internal caller and test to the direct functions they wrap.

**Architecture:** Each wrapper is a pure 1:1 pass-through to an already-exported function, so this is a behavior-preserving refactor. Each task removes one wrapper and atomically updates its consumers + tests so the build/test gate stays green at every commit. No back-compat shim (clean removal — pre-1.0, undocumented, no production dependants).

**Tech Stack:** TypeScript, Vitest, pnpm workspace, Biome (format/lint), lefthook pre-commit gate.

**Spec:** `docs/superpowers/specs/2026-06-25-remove-deprecated-wrappers-design.md`

**Gate commands:**
- Targeted tests: `pnpm -C ts-core exec vitest run <file…>`
- Full ts-core tests: `pnpm -C ts-core test:run`
- Fast gate (format + lint + typecheck, monorepo): `pnpm verify:fast`

---

### Task 1: Remove `SysInfo`, migrate logger + barrel + test

**Files:**
- Modify: `ts-core/src/loggers/common/index.ts` (lines 4, 97, 116)
- Modify: `ts-core/src/utils/index.ts` (line 65)
- Modify: `ts-core/src/utils/SysInfo.ts` (lines 210-218)
- Test: `ts-core/src/loggers/index.test.ts` (line 18; spy sites at 112, 120, 154, 169; assertion text at 111, 119)

- [ ] **Step 1: Migrate the logger consumer**

In `ts-core/src/loggers/common/index.ts`, change the import (line 4):

```ts
import { getSysInfo } from "../../utils/SysInfo";
```

Change the telemetry-cache type (line 97):

```ts
		value: ReturnType<typeof getSysInfo>;
```

Change the call site (line 116):

```ts
				value: getSysInfo(),
```

- [ ] **Step 2: Drop `SysInfo` from the utils barrel**

In `ts-core/src/utils/index.ts`, change line 65 from
`export { getSysInfo, SysInfo } from "./SysInfo";` to:

```ts
export { getSysInfo } from "./SysInfo";
```

- [ ] **Step 3: Delete the deprecated `SysInfo` export**

In `ts-core/src/utils/SysInfo.ts`, delete the entire trailing block (lines 210-218):

```ts
/**
 * @deprecated Use getSysInfo or detectRuntime instead.
 */
export const SysInfo = {
	/**
	 * Gets system information.
	 */
	get: getSysInfo,
};
```

The file ends after the `getSysInfo()` function. Leave a single trailing newline. Do **not** rename the file (it still exports `getSysInfo`).

- [ ] **Step 4: Migrate the logger test to a namespace-import spy**

In `ts-core/src/loggers/index.test.ts`, change the import (line 18):

```ts
import * as SysInfoModule from "../utils/SysInfo";
```

Replace all four occurrences of `vi.spyOn(SysInfo, "get")` (lines 112, 120, 154, 169) with:

```ts
		const spy = vi.spyOn(SysInfoModule, "getSysInfo");
```

(This is the documented Vitest ESM pattern: the wrapper's named `getSysInfo` import is a live binding into the same module namespace, so spying on `SysInfoModule.getSysInfo` is observed by the wrapper.)

Update the two `it(...)` descriptions for clarity (cosmetic):
- line 111: `"defaults telemetry to off and does not call getSysInfo()"`
- line 119: `"calls getSysInfo() when telemetry is enabled"`

- [ ] **Step 5: Run the logger test to verify it passes**

Run: `pnpm -C ts-core exec vitest run src/loggers/index.test.ts`
Expected: PASS (all telemetry/child-logger specs green, including the `getSysInfo` spy assertions).

- [ ] **Step 6: Commit**

```bash
git add ts-core/src/loggers/common/index.ts ts-core/src/utils/index.ts ts-core/src/utils/SysInfo.ts ts-core/src/loggers/index.test.ts
git commit -m "refactor: remove deprecated SysInfo wrapper, use getSysInfo directly"
```

---

### Task 2: Remove `RequestResponseSerialize`

**Files:**
- Modify: `ts-core/src/retrieve/RequestResponseSerialize.ts` (lines 86-91)
- Modify: `ts-core/src/retrieve/index.ts` (line 19)

No production or test code calls `RequestResponseSerialize.serialize` (verified — only the barrel re-export references it).

- [ ] **Step 1: Delete the deprecated `RequestResponseSerialize` export**

In `ts-core/src/retrieve/RequestResponseSerialize.ts`, delete the trailing block (lines 86-91):

```ts
/**
 * @deprecated Use serializeResponse instead.
 */
export const RequestResponseSerialize = {
	serialize: serializeResponse,
};
```

The file ends after the `serializeResponse()` function. Leave a single trailing newline.

- [ ] **Step 2: Drop the barrel re-export**

In `ts-core/src/retrieve/index.ts`, delete line 19:

```ts
export { RequestResponseSerialize } from "./RequestResponseSerialize";
```

Keep the adjacent type export on line 18 (`export type { SerializedResponse } from "./RequestResponseSerialize";`) unchanged.

- [ ] **Step 3: Verify the retrieve suite still passes**

Run: `pnpm -C ts-core exec vitest run src/retrieve/RequestResponseSerialize.test.ts`
Expected: PASS (the suite exercises `serializeResponse` directly; nothing referenced the removed object).

- [ ] **Step 4: Commit**

```bash
git add ts-core/src/retrieve/RequestResponseSerialize.ts ts-core/src/retrieve/index.ts
git commit -m "refactor: remove deprecated RequestResponseSerialize wrapper"
```

---

### Task 3: Remove `RequestUnlimited`

**Files:**
- Modify: `ts-core/src/retrieve/RequestUnlimited.ts` (lines 328-335)
- Modify: `ts-core/src/retrieve/index.ts` (lines 21-25)
- Test: `ts-core/src/retrieve/RequestUnlimited.test.ts` (line 19; lines 341-344)
- Test: `ts-core/src/retrieve/RequestProxied.test.ts` (line 30)

`DEFAULT_REQUEST_OPTIONS`, `endPoint`, and `endPoints` are all already exported from `RequestUnlimited.ts`, so the tests migrate directly to them. Edit the tests **before** removing the source export so no intermediate state references a missing symbol.

- [ ] **Step 1: Migrate `RequestUnlimited.test.ts`**

In `ts-core/src/retrieve/RequestUnlimited.test.ts`, change the import (line 19):

```ts
import { DEFAULT_REQUEST_OPTIONS, endPoint, endPoints } from "./RequestUnlimited";
```

Rewrite the `defaults` assertions (lines 341-344):

```ts
		it("should use DEFAULT_REQUEST_OPTIONS when no options provided", () => {
			expect(DEFAULT_REQUEST_OPTIONS.timeout).toBe(50000);
			expect((DEFAULT_REQUEST_OPTIONS.retry as any).limit).toBe(5);
		});
```

- [ ] **Step 2: Drop the stale mock key in `RequestProxied.test.ts`**

In `ts-core/src/retrieve/RequestProxied.test.ts`, delete the `RequestUnlimited: {},` line (line 30) from the `vi.mock("./RequestUnlimited", …)` factory. The factory after this edit returns:

```ts
	return {
		endPoint: mockEndPoint,
		endPoints: mockEndPoints,
		DEFAULT_REQUEST_OPTIONS: {},
	};
```

- [ ] **Step 3: Delete the deprecated `RequestUnlimited` export**

In `ts-core/src/retrieve/RequestUnlimited.ts`, delete the trailing block (lines 328-335):

```ts
/**
 * @deprecated Use endPoint/endPoints functions directly.
 */
export const RequestUnlimited = {
	defaults: DEFAULT_REQUEST_OPTIONS,
	endPoint,
	endPoints,
};
```

- [ ] **Step 4: Drop the barrel re-export**

In `ts-core/src/retrieve/index.ts`, replace the multi-line export group (lines 21-25):

```ts
export {
	endPoint,
	endPoints,
	RequestUnlimited,
} from "./RequestUnlimited";
```

with:

```ts
export { endPoint, endPoints } from "./RequestUnlimited";
```

Leave the `export type { RequestResult } from "./RequestUnlimited";` line (line 20) unchanged.

- [ ] **Step 5: Run the affected retrieve tests**

Run: `pnpm -C ts-core exec vitest run src/retrieve/RequestUnlimited.test.ts src/retrieve/RequestProxied.test.ts`
Expected: PASS (defaults assertions now read `DEFAULT_REQUEST_OPTIONS`; proxied suite unaffected by the dropped mock key).

- [ ] **Step 6: Commit**

```bash
git add ts-core/src/retrieve/RequestUnlimited.ts ts-core/src/retrieve/index.ts ts-core/src/retrieve/RequestUnlimited.test.ts ts-core/src/retrieve/RequestProxied.test.ts
git commit -m "refactor: remove deprecated RequestUnlimited wrapper, use endPoint/endPoints directly"
```

---

### Task 4: Full-gate verification + removal guard

**Files:** none modified (verification only).

- [ ] **Step 1: Guard that no deprecated-object definitions or member accesses remain**

Run: `rg -n "export const (SysInfo|RequestUnlimited|RequestResponseSerialize) =" ts-core/src`
Expected: no matches.

Run: `rg -n "SysInfo\.get|RequestUnlimited\.|RequestResponseSerialize\." ts-core/src`
Expected: no matches.

(Bare-word mentions of these names remain in file headers / `logger.child({ section: … })` strings — those are comments/log labels, not the removed objects, and are expected.)

- [ ] **Step 2: Run the fast gate (format + lint + typecheck)**

Run: `pnpm verify:fast`
Expected: PASS — Biome format/lint clean and `typecheck-all` reports no errors across the workspace (confirms no other package imported the removed symbols).

- [ ] **Step 3: Run the full ts-core test suite**

Run: `pnpm -C ts-core test:run`
Expected: PASS — entire `ts-core` Vitest suite green.

- [ ] **Step 4 (if any guard/gate fails): fix and re-run**

If Step 1 finds a match, remove or migrate that reference per Tasks 1-3. If Step 2/3 fails, address the specific error and re-run that command until green. No commit if Steps 1-3 were already clean (this task adds no code).

---

## Self-Review

**Spec coverage:**
- Spec §"Changes by symbol → 1. SysInfo" → Task 1 (all four edit points + test). ✓
- Spec §"2. RequestUnlimited" → Task 3 (source, barrel, both tests, `DEFAULT_REQUEST_OPTIONS` swap). ✓
- Spec §"3. RequestResponseSerialize" → Task 2 (source + barrel; no caller). ✓
- Spec §"Non-goals" (no file rename, no function changes) → honored (Task 1 Step 3 note; no task touches `endPoint`/`endPoints`/`serializeResponse`/`getSysInfo` bodies). ✓
- Spec §"Testing & verification" (verify:fast, three test files, grep guard, README untouched) → Task 4 + per-task targeted runs; README not in any task. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows exact code; every command has an expected result. ✓

**Type consistency:** `getSysInfo`, `DEFAULT_REQUEST_OPTIONS`, `endPoint`, `endPoints`, `serializeResponse`, `SerializedResponse`, `RequestResult` are spelled identically across tasks and match the verified current exports. The namespace alias `SysInfoModule` is used consistently in Task 1 Step 4. ✓
