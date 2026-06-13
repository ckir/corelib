# ConfigManager / Boot-Hardening Design Spec — Final Agity Review Pass

**Date:** 2026-06-13  
**Epic:** 1 (ConfigManager & Boot-Hardening)  
**Reviewer Agent:** Antigravity (agy)  
**Status:** COMPLETE / APPROVED  

---

## 1. State Verification (Step 0)

We have verified the contents of the final design spec [2026-06-13-configmanager-boot-hardening-design.md](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-c0e00fbd/docs/superpowers/specs/2026-06-13-configmanager-boot-hardening-design.md) exactly matches the expected structure:
- **§4 CLI Parsing:** Accurately describes a hand-rolled ~25-line light-weight argv parser and explicitly states that `commander` is removed.
- **§5 Concurrency:** Correctly defines single-flight `initialize` with failure eviction, internal serialized mutations via `_mutationChain` mutex, sync-to-async clobber mitigation via `_inFlightTempConfig` dual-write, and the staged-build `clearAndFill` deep-in-place mutation.

---

## 2. In-Depth Oracle & Contract Verification

### 1. §4 PARSER CONTRACT
The hand-rolled parser loop successfully reproduces all five specified observable CLI contracts:
1. **`-C <path>` / `--config <path>` / `--config=<path>` → External Config:**
   - Consumed properly on `-C` or `--config` with lookahead check `i + 1 < argv.length && !argv[i + 1].startsWith("-")`.
   - Properly sliced on `--config=`.
   - Extracted early, preventing these flags from polluting the dynamic override stream.
2. **Kebab-Case Override Flags:**
   - Handled correctly via `--kebab-case value` and `--kebab-case=value`.
3. **Bare Trailing `--flag`:**
   - Evaluated as boolean `true` if it's the last argument or followed by another flag.
4. **Edge Runtimes Safe Guarding:**
   - `process.argv` is carefully checked and falls back to `[]` under non-Node edge runtimes, eliminating any un-guarded global object access.
   - Entirely removes potential process crashes or `process.exit` loops.
5. **No Greedy Flag Consuming:**
   - If the next token starts with `-` (e.g., `--config --flag` or `--flag1 --flag2`), the parser correctly leaves the subsequent flag un-consumed so it can be handled independently as its own flag/override.

### 2. §4 COERCION ORDERING
The proposed coercion/assignment ordering is confirmed to be **byte-identical** to the existing implementation pipeline:
- `extract` → `skip config` → `isSafeKey` → `kebab→dot (key.replace(/-/g, "."))` → `parseValue` → `setPath`.
The global replacement regex `/-/g` matches the production behavior perfectly, assuring no risk of configuration value drift.

### 3. §5 CONCURRENCY
The design successfully closes all open bootstrap concurrency races:
- **Idempotency:** Re-invests simultaneous/concurrent boots into the single-flight `this._initPromise` cached return value.
- **Eviction-on-Failure:** A failed asynchronous initialization cleanly evicts the failed promise by setting `this._initPromise = null`, allowing subsequent retries to attempt bootstrapping again.
- **Serialization:** Both `initialize` and async mutator `loadExternalConfig` utilize `_mutationChain` to prevent interleaved tree-merging races.
- **Sync-Async Clobber Solution:** The staging builder dual-writes to the private `_inFlightTempConfig` field. Programmatic synchronous/atomic updates (via `updateValue`) therefore survive the eventual swap and are never lost inside the event loop.
- **Staged Builders Boundary:** Builders strictly receive an explicit `target` parameter and never re-bind `this._config` in mid-execution, meaning `this._config` is always read-safe.

### 4. `clearAndFill` (§5.4)
The custom `clearAndFill` deep mutator is extremely robust:
- **Pruning & Cleaning:** Iterates through existing/stale target keys and removes any properties that do not exist in the source.
- **Array Contract:** Avoids array merging/concatenation; arrays and primitives overwrite the target key wholesale.
- **Identity Retention:** Preserves the underlying nested object identities where shapes match, meaning active downstream module caches remain pointing to the correct properties.
- **Sysconfig Matching:** Keeps `globalThis.sysconfig === this._config` identity true through the entire lifetime of the process.

### 5. PROTO-POLLUTION
The introduction of `isSafeKey` splitting on `/[.-]/` cleanly bars any polluted keys:
- Perfectly handles kebab cases like `--constructor-foo` by splitting on hyphens and examining individual blocks.
- It correctly blocks suspicious paths containing `__proto__`, `constructor`, or `prototype` segments while offering zero over-blocking on standard compound business keys (e.g. `constructor_name`).

---

## 3. Verdict

The final spec text is highly cohesive, secure, and ready for development. It completely addresses all 7 boots/lifecycle vulnerabilities reported in the audit. 

**AGY-VERDICT: APPROVE**
