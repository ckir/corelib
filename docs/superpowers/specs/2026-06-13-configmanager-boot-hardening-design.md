# ConfigManager / Boot-Hardening — Design Spec

**Date:** 2026-06-13
**Epic:** 1 (first fix cycle following the 2026-06-13 monorepo optimization audit)
**Status:** design — production changes IN scope this cycle
**Owner file:** `ts-core/src/configs/ConfigManager.ts` (+ a small memoize in `ts-core/src/utils/runtime.ts`)

---

## 1. Purpose & scope

Consolidate the **7 entangled boot-layer findings** from the 2026-06-13 audit
(`docs/superpowers/audits/2026-06-13-monorepo-audit-findings.md`) into one cohesive
design-to-implementation loop. These findings share a single root cause and cannot be
fixed in isolation without re-touching the same lines, so they are deliberately treated
as one atomic epic.

**Findings in scope:**

| id | sev | one-line |
|----|-----|----------|
| `boot-ConfigManager-cli-override-process-exit-07` | HIGH (confirmed-by-probe) | commander@15 `process.exit(1)` on any override flag |
| `boot-ConfigManager-initialize-races-01` | HIGH | `initialize()` has no concurrent-init guard |
| `boot-ConfigManager-partial-init-window-02` | HIGH | singleton usable before async `initialize()` resolves; `_config` starts `{}` |
| `boot-ConfigManager-sysconfig-reference-severance-09` | medium | `globalThis.sysconfig` reassigned; early captures go stale |
| `boot-ConfigManager-process-argv-unguarded-08` | medium | `process.argv` read unguarded on edge runtimes |
| `boot-ConfigManager-loadExternalConfig-concurrent-05` | medium | public async mutator, no mutex vs `initialize` or itself |
| `boot-detectRuntime-uncached-06` | low | runtime probe ladder re-run every call |

**Out of scope** (explicitly NOT this epic, tracked in ROADMAP for later epics):
`boot-RequestUnlimited-*` (retry/backoff), all `phase0-logger-*`, all `facade-*`,
all `ffi-*` / `engine-*`. The `affected:["ffi"]` tags on the race findings are addressed
*at the source* here (config can no longer be empty/half-merged); the FFI-side
defense-in-depth lives in Epic 2.

**Non-goals (YAGNI):** no schema/validation framework, no config hot-reload/file-watching,
no new config file formats, no public API beyond the two readiness accessors below.

---

## 2. Root cause & guiding invariant

Every finding traces to the same defect: **`this._config` is reassigned to fresh objects
at multiple asynchronous points** (`initialize` `:188`, `loadDefaults` `:238/:244`,
`processHierarchy` `:363`) while the singleton is already live and `globalThis.sysconfig`
was bound — in the constructor — to the *empty initial* object. Reassignment severs that
binding, and the multi-await `initialize()` has no guard against concurrent or repeat calls.

**Guiding invariant (the spine of this design):**

> `this._config` is created **once** and its object reference **never changes** for the
> life of the process. All mutation happens **in place**. The identity
> `globalThis.sysconfig === this._config` holds from constructor to process exit.

---

## 3. Read contract (resolves -02, -09)

`get()` / `getConfig()` remain **synchronous and non-throwing** — this is a hard
compatibility constraint, because `ConfigManager.get(path)` is consumed pervasively and
synchronously across `ts-markets` (`MarketSymbols`, `MarketMonitor`, `MarketStatus`,
`ApiNasdaq*`, `CnnFearAndGreed`, …), always wrapped `?? <default>`. A throwing or async
getter would be a breaking change across the whole consumer surface.

**Changes:**

1. **Seed defaults synchronously in the constructor.** `builtinDefaults` (the bundled
   `ConfigManager.json`) is loaded into `this._config` *in the constructor*, so a read
   before `initialize()` resolves returns real defaults instead of `undefined`/`{}`.
2. **Permanent reference.** The constructor binds `globalThis.sysconfig = this._config`
   exactly once; nothing ever reassigns `this._config` again (see §5).
3. **Readiness API (additive, non-breaking):**
   - `public get isInitialized(): boolean`
   - `public whenReady(): Promise<void>` — resolves when the first `initialize()` settles
     successfully; orchestrators / long-lived drivers (DB connections, stream wrappers)
     should `await whenReady()` before lifecycle execution.
4. **Premature-read warning (dev/test only).** When `get()` is called while
   `isInitialized === false`, emit a single non-blocking `_logger.warn` naming the path —
   **suppressed when `NODE_ENV === "production"`** (no log spam in prod; signal in dev).
   This surfaces the "defaults silently masked a required override" hazard without changing
   the return contract.
5. **README anti-pattern note.** Document that caching a *sub-section* of config at module
   scope (`const db = ConfigManager.get("db")`) is discouraged; read at the hot point. The
   in-place mutation (§5) preserves nested object identity where structurally possible, but
   the documented contract is "read at use site."

---

## 4. CLI parsing — neuter commander in place (resolves -07, -08)

Commander is **retained** (dependency stays) but made incapable of terminating the host.

**Why the current code crashes (`-07`):** `applyCliOverrides()` reads `program.args` and
scans it for `--kebab` flags. This works because commander historically routes *unknown*
options into the operands/`args` array when `allowUnknownOption(true)` is set. Under
commander@15, an unknown long option is classified as an **excess argument** and
`program.error()` → `process.exit(1)` fires **before** the flag ever reaches `program.args`.
`allowUnknownOption(true)` alone does not cover this.

**Fix — make `parseAsync` non-fatal AND let the flags reach `program.args`:**

```ts
const program = new Command();
program.exitOverride();                 // throw instead of process.exit()
program.allowUnknownOption(true);       // already present
program.allowExcessArguments(true);     // NEW: stop excess-argument errors
program.helpOption(false);
program.option("-C, --config <path>", "external config file or URL");
try {
  await program.parseAsync(argv, { from: "user" });
} catch (e) {
  // exitOverride turns commander's terminating errors into throwables; a parse
  // hiccup must NOT crash a library bootstrap. Log + continue with whatever was
  // parsed (config defaults still apply).
  this.logError("CLI parse produced a non-fatal commander error", e);
}
```

With `allowExcessArguments(true)`, unknown `--flag[=value]` entries land in `program.args`
and the **existing** `applyCliOverrides(program)` logic applies them unchanged. The flipped
probe (§7) is the oracle proving overrides actually flow through; if commander@15 is found
to *not* populate `program.args` even when neutered, the contingency is to parse the
override flags directly from the guarded `argv` slice (same parse logic, fed from `argv`
instead of `program.args`) — commander then serves only `-C` extraction. The implementer
picks the path the probe oracle validates; both satisfy the same observable contract.

**Guard `process.argv` (`-08`):**

```ts
const argv = args ?? (
  typeof process !== "undefined" && Array.isArray(process.argv)
    ? process.argv.slice(2)
    : []
);
```

---

## 5. Concurrency & atomic mutation (resolves -01, -05, and agy's 8th hazard)

### 5.1 Single-flight `initialize()` with failure eviction

```ts
private _initPromise: Promise<void> | null = null;
private _isInitialized = false;

public initialize(args?: string[]): Promise<void> {
  if (this._initPromise) return this._initPromise;     // idempotent under concurrency (-01)
  this._initPromise = (async () => {
    try {
      await this.runInitSequence(args);
      this._isInitialized = true;
    } catch (error) {
      this._initPromise = null;   // EVICT on failure so a transient error can self-heal
      throw error;
    }
  })();
  return this._initPromise;
}
```

The failure-eviction (`_initPromise = null` on reject) closes the **failed-init lock-out**
hazard agy surfaced: without it, one transient network failure fetching an external config
would cache a permanently-rejected promise and wedge the process unrecoverably.

> Signature note: `initialize` keeps `(args?: string[]): Promise<void>` byte-for-byte — it
> is already awaited at every call site (`README`, integration tests' `initialize([])`).
> It changes from `async` to a sync function returning the cached promise; externally
> identical (still thenable/awaitable, still resolves `undefined`).

### 5.2 Mutator serialization

`loadExternalConfig()` is serialized against `initialize()` and itself via a tiny internal
async mutex (a `private _mutationChain: Promise<unknown>` that each async mutator chains
onto). This prevents interleaved hierarchy merges (`-05`). `updateValue()` stays
**synchronous** (its callers, e.g. integration tests, depend on sync semantics); it does a
single in-place `setPath` on the live `_config` and emits.

**Sync-vs-async clobber (agy convergent CONCERN #4).** A synchronous `updateValue()` that
lands *between awaits* of an in-flight `initialize`/`loadExternalConfig` would be silently
overwritten by the final `clearAndFill` swap. To preserve sync-read-after-write semantics
without breaking the staged build, the in-flight builder publishes its staging object on a
`private _inFlightTempConfig: Record<string, unknown> | null` (set non-null only while a
staged build is running, cleared in a `finally`). `updateValue()` applies its `setPath` to
the live `_config` **and**, if `_inFlightTempConfig !== null`, to that staging object too —
so the value survives the swap. This is the lowest-risk fix; it adds one nullable field and
a two-line dual-write, no API change.

### 5.3 Staged-build + atomic in-place swap

No mutator reassigns `this._config`. Instead each rebuild is computed on a throwaway
`tempConfig` and committed with one synchronous deep in-place write.

**Implementation constraint (agy convergent CONCERN #3) — do NOT temp-swap the field.**
The private builders (`loadDefaults`, `processHierarchy`, `applyEnvOverrides`,
`applyCliOverrides`) currently mutate `this._config` directly. They MUST be refactored to
accept an explicit `target: Record<string, unknown>` parameter and operate on *that* object.
The implementer must **not** take the shortcut of temporarily doing `this._config = tempConfig`
around the build and swapping back — that re-introduces the exact reference-severance and
half-formed-read race this epic exists to kill. The canonical `this._config` is touched in
exactly one place per mutator: the final `clearAndFill(this._config, tempConfig)`.

Staged build:

- **`initialize` / `runInitSequence`:** build `tempConfig = {}` → seed defaults → external
  hierarchy → env overrides → CLI overrides, **then** `clearAndFill(this._config, tempConfig)`.
- **`loadExternalConfig`:** `tempConfig = structuredClone(this._config)` → merge external
  hierarchy → re-apply env → `clearAndFill(this._config, tempConfig)` (preserves
  "merge on top of current" semantics).

A mid-build failure (network, decrypt, parse) throws **before** the swap, leaving
`this._config` untouched — never a half-merged/poisoned state.

### 5.4 `clearAndFill` — the in-place deep mutator

Preserves the existing `leafMerger({ mergeArrays: false })` "arrays are leaves" contract
while keeping object identity:

```ts
function clearAndFill(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  for (const key of Object.keys(target)) {
    if (!(key in source)) delete target[key];            // prune removed keys
  }
  for (const key of Object.keys(source)) {
    const val = source[key];
    if (val && typeof val === "object" && !Array.isArray(val)) {
      if (!target[key] || typeof target[key] !== "object" || Array.isArray(target[key])) {
        target[key] = {};
      }
      clearAndFill(target[key] as Record<string, unknown>, val as Record<string, unknown>);
    } else {
      target[key] = val;                                 // arrays + primitives replace wholesale
    }
  }
}
```

Guarantees: `globalThis.sysconfig === this._config` stays true; nested objects keep
identity where the shape matches; arrays replace (not merge); atomic — only runs after a
clean build.

---

## 6. detectRuntime memoization (resolves -06)

`ts-core/src/utils/runtime.ts`:

```ts
let _cachedRuntime: Runtime | undefined;
export function detectRuntime(): Runtime {
  if (_cachedRuntime !== undefined) return _cachedRuntime;
  _cachedRuntime = computeRuntime();   // existing ladder, extracted
  return _cachedRuntime;
}
/** Test-only: clear the memoized runtime (some tests flip RUNTIME=). */
export function __resetRuntimeCache(): void { _cachedRuntime = undefined; }
```

The existing probe ladder body moves verbatim into `computeRuntime()`. Any test that
mutates `process.env.RUNTIME` between assertions must call `__resetRuntimeCache()`.

---

## 7. Testing & oracles

**Pinning oracle (already exists):**
`probes/js/configmanager-init-race.probe.test.ts` currently *passes while `-07` is present*
and **flips to failing when fixed**. On the fix, update it to the fixed-contract oracle:
`initialize(['--probeflag=hello'])` resolves, `get('probeflag') === 'hello'`, and
`process.exit` is never called. This flip is the headline success signal for the epic.

**New unit tests** (`vitest`, under `ts-core/tests/configs/`):
1. **single-flight idempotency:** `Promise.all([cm.initialize(a), cm.initialize(b)])` →
   resolves once; config internally consistent; no clobber.
2. **failed-init eviction:** an `initialize()` whose external fetch rejects → promise
   rejects, `isInitialized === false`, a subsequent `initialize([])` succeeds (self-heal).
3. **reference identity:** capture `globalThis.sysconfig` before init; after init the
   reference is `===` and observes the new values.
4. **`clearAndFill`:** array-replace (not merge), key-prune, nested-object identity
   preserved, primitive overwrite.
5. **CLI parse matrix:** `-C path`, `--config=path`, `--k v`, `--k=v`, and the
   no-`process.argv` edge path (`args` omitted under a stubbed `process`).
6. **premature-read warning:** warns in dev, silent under `NODE_ENV=production`; `get()`
   returns seeded default either way.
7. **detectRuntime:** memoized (second call cheap / stable), `__resetRuntimeCache()` works.
8. **sync→async clobber survival** (agy CONCERN #5): a synchronous `updateValue(path, v)`
   issued while a `loadExternalConfig`/`initialize` build is mid-await is still observable
   via `get(path)` after the staged swap commits (verifies the `_inFlightTempConfig`
   dual-write of §5.2).
9. **non-fatal CLI parse:** a malformed/odd argv that makes commander throw under
   `exitOverride()` is caught, logged, and `initialize()` still resolves (no `process.exit`,
   bootstrap continues with defaults).

**Regression gate (must stay green):** existing `initialize([])` call sites in
`ts-core/tests/integration/*`, `ts-markets/tests/integration/*` and the lefthook
`verify:fast` / `verify:full` chains.

---

## 8. Error handling summary

| Failure | Behavior |
|---------|----------|
| CLI parse error (commander) | caught, logged via `logError`, init continues with defaults |
| External config fetch/parse/decrypt fails mid-`initialize` | throws before swap → `_config` untouched → `_initPromise` evicted → retryable |
| External config fails in `loadExternalConfig` | throws after logging → live `_config` untouched (built on clone) |
| Read before ready | returns seeded default; dev/test warning; never throws |
| Concurrent `initialize` calls | all await the one in-flight promise |

---

## 9. Affected files

- **`ts-core/src/configs/ConfigManager.ts`** — primary: constructor seeding, permanent
  ref, single-flight `initialize`, `runInitSequence`, mutex, staged-build + `clearAndFill`,
  neutered commander, guarded argv, readiness API, premature-read warning.
- **`ts-core/src/utils/runtime.ts`** — `detectRuntime` memoization + `__resetRuntimeCache`.
- **`probes/js/configmanager-init-race.probe.test.ts`** — flip to fixed-contract oracle.
- **`ts-core/tests/configs/*`** — new unit tests (§7).
- **`ts-core/README.md`** (+ root `README.md`) — readiness API + sub-section-cache anti-pattern note.
- **`ROADMAP.md`** — mark the 7 findings resolved under Epic 1; carry-forward unchanged.

No public API removed; `commander` dependency retained. `ignoreDeprecations "6.0"` and the
lefthook gate are respected as-is (no new flags).
