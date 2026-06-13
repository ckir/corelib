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

## 4. CLI parsing — drop commander, hand-roll a dedicated parser (resolves -07, -08)

**Decision (agy + Claude converged, under the Reproducibility Rule):** `commander` is
**removed** from `ts-core` and replaced with a ~25-line dedicated argv parser. The CLI
requirement here is unusual — *accept arbitrary unknown `--kebab` flags as config data* —
which is the opposite of what commander/yargs/cac are built for (they reject unknown
options; that rejection IS the `-07` crash). `node:util parseArgs` was evaluated and
rejected: in `strict:false` it parses an unconfigured `--key value` as `{key:true}` + a
stray positional `"value"`, so reproducing our contract would require a manual token
lookahead anyway (drift risk, no benefit). minimist/mri were rejected for prototype-pollution
history at a config boundary. The hand-roll has **zero behavioral-drift risk** because it
*extends the existing `applyCliOverrides` semantics* rather than swapping the parser's
opinions, and is structurally incapable of `process.exit` (fixes `-07`).

**Why the current code crashes (`-07`):** `applyCliOverrides()` reads commander's
`program.args`, relying on commander routing *unknown* options there. Under commander@15 an
unknown long option is classified as an **excess argument** and `program.error()` →
`process.exit(1)` fires before the flag is ever reachable — a library bootstrap calling
`process.exit(1)` on caller/CLI/env-derived input is a crash/DoS hazard.

**The observable CLI contract the parser MUST reproduce exactly (the oracle):**
- `-C <path>` / `--config <path>` / `--config=<path>` → external config path (consumed, not an override).
- arbitrary `--kebab-case value` and `--kebab-case=value` → config overrides.
- a bare trailing `--flag` with no following value → boolean `true`.
- never call `process.exit`; on edge runtimes (no `process.argv`) → empty arg set.
- a value that is the *next token starting with `-`* is NOT consumed as the flag's value
  (matches the current loop, which only consumes a following non-flag token).

**Guard `process.argv` (`-08`) — the single argv source:**

```ts
const argv = args ?? (
  typeof process !== "undefined" && Array.isArray(process.argv)
    ? process.argv.slice(2)
    : []
);
```

**Parser shape (replaces commander + the current applyCliOverrides body):**

```ts
// 1. Extract -C / --config (consumed, removed from the override stream).
let configPath: string | undefined;
// 2. Collect arbitrary --kebab overrides into a flat dict.
const overrides: Record<string, string | boolean> = {};

for (let i = 0; i < argv.length; i++) {
  const tok = argv[i];
  if (tok === "-C" || tok === "--config") {
    if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) configPath = argv[++i];
    continue;
  }
  if (tok.startsWith("--config=")) { configPath = tok.slice("--config=".length); continue; }
  if (!tok.startsWith("--")) continue;        // ignore bare operands (current behavior)

  let key = tok.slice(2);
  let value: string | boolean;
  const eq = key.indexOf("=");
  if (eq > -1) { value = key.slice(eq + 1); key = key.slice(0, eq); }
  else if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) { value = argv[++i]; }
  else { value = true; }                       // bare --flag → true
  overrides[key] = value;
}
```

**Prototype-pollution guard (defense-in-depth, fixes a latent `setPath` hazard).** Before a
kebab key is mapped to a dot-path and written, reject any segment that is `__proto__`,
`constructor`, or `prototype`:

```ts
const isSafeKey = (key: string): boolean =>
  !key.split(/[.-]/).some(p => p === "__proto__" || p === "constructor" || p === "prototype");
```

**Coercion/assignment ordering is byte-identical to today** so values don't drift:
extract → skip `config` → `isSafeKey(key)` (else drop + warn) → kebab→dot (`key.replace(/-/g,".")`)
→ `parseValue(value)` (existing JSON/number/bool coercion) → `setPath(target, path, coerced)`.
`-C` extraction now happens *before* the hierarchy load (§5.3) instead of via a parsed
`program`, and `loadExternalConfig`'s stale "cache the parsed program" comment (`:215-216`)
is removed.

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

**Existing colocated test (must stay green):** `ts-core/src/configs/ConfigManager.argv.test.ts`
asserts `initialize([])` bypasses `process.argv` and resolves — still true under the
hand-rolled parser. Update only its stale "bypass commander's argv scan" comment.

**New unit tests** (`vitest`, **colocated** per repo convention as
`ts-core/src/configs/ConfigManager.*.test.ts` — unit tests live next to source; only
integration tests live under `ts-core/tests/integration/`):
1. **single-flight idempotency:** `Promise.all([cm.initialize(a), cm.initialize(b)])` →
   resolves once; config internally consistent; no clobber.
2. **failed-init eviction:** an `initialize()` whose external fetch rejects → promise
   rejects, `isInitialized === false`, a subsequent `initialize([])` succeeds (self-heal).
3. **reference identity:** capture `globalThis.sysconfig` before init; after init the
   reference is `===` and observes the new values.
4. **`clearAndFill`:** array-replace (not merge), key-prune, nested-object identity
   preserved, primitive overwrite.
5. **CLI parse matrix:** `-C path`, `--config=path`, `--k v`, `--k=v`, bare trailing
   `--flag` → `true`, a `--flag --next` pair (first flag → `true`, not consuming `--next`),
   the no-`process.argv` edge path (`args` omitted under a stubbed `process`), and an
   `isSafeKey` rejection (`--__proto__.x=1` dropped + warned, no pollution).
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
| Malformed CLI token | parser cannot throw/exit; unparseable tokens are ignored, init continues with defaults |
| Unsafe override key (`__proto__`/`constructor`/`prototype`) | dropped + dev/test warning; never written to config |
| External config fetch/parse/decrypt fails mid-`initialize` | throws before swap → `_config` untouched → `_initPromise` evicted → retryable |
| External config fails in `loadExternalConfig` | throws after logging → live `_config` untouched (built on clone) |
| Read before ready | returns seeded default; dev/test warning; never throws |
| Concurrent `initialize` calls | all await the one in-flight promise |

---

## 9. Affected files

- **`ts-core/src/configs/ConfigManager.ts`** — primary: constructor seeding, permanent
  ref, single-flight `initialize`, `runInitSequence`, mutex + `_inFlightTempConfig`,
  staged-build + `clearAndFill`, hand-rolled argv parser + `isSafeKey`, guarded argv,
  readiness API, premature-read warning. Removes the `import { Command } from "commander"`.
- **`ts-core/src/utils/runtime.ts`** — `detectRuntime` memoization + `__resetRuntimeCache`.
- **`ts-core/package.json`** — remove `commander` from dependencies (if no other ts-core
  source imports it — verify with a repo grep before removing; only ConfigManager uses it).
- **`probes/js/configmanager-init-race.probe.test.ts`** — flip to fixed-contract oracle.
- **`ts-core/src/configs/ConfigManager.argv.test.ts`** — keep green; update stale commander comment.
- **`ts-core/src/configs/ConfigManager.*.test.ts`** — new colocated unit tests (§7).
- **`ts-core/README.md`** (+ root `README.md`) — readiness API + sub-section-cache anti-pattern note.
- **`ROADMAP.md`** — mark the 7 findings resolved under Epic 1; carry-forward unchanged.

No public API removed; `commander` dependency **dropped** from `ts-core` (replaced by the
hand-rolled parser). `ignoreDeprecations "6.0"` and the lefthook gate are respected as-is
(no new flags).
