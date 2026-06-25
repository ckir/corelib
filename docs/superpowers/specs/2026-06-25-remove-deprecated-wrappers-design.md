# Remove Deprecated Wrapper Objects — Design

**Date:** 2026-06-25
**Status:** Approved (design)
**Scope:** `ts-core` (with one mock-only touch surfaced via `retrieve/index.ts` consumers)

## Goal

Delete the three `@deprecated` wrapper objects in `ts-core` and migrate every
internal caller and test to the direct functions they wrap. End state: zero
`@deprecated` symbols in `ts-core`, and nothing importing the removed objects.

| Deprecated symbol | Wraps | Replacement |
|---|---|---|
| `SysInfo` (`.get`) | `getSysInfo` | `getSysInfo()` |
| `RequestUnlimited` (`.endPoint` / `.endPoints` / `.defaults`) | `endPoint`, `endPoints`, `DEFAULT_REQUEST_OPTIONS` | the functions / const directly |
| `RequestResponseSerialize` (`.serialize`) | `serializeResponse` | `serializeResponse()` |

Each wrapper is a pure pass-through to an already-exported function, so this is a
mechanical refactor with **no runtime behavior change**.

## Decision

**Clean removal, no back-compat shim.** Chosen over keeping the deprecated exports
as shims. These objects are part of the public API of the published
`@ckirg/corelib` package (v0.1.22), so removal is technically breaking — accepted
because:

- the package is pre-1.0 (0.x semver permits breaking changes),
- all three are already marked `@deprecated`,
- none are documented in `README.md` (it documents only the direct functions),
- no production code path depends on them (production already prefers the direct
  functions — e.g. `loggers/implementations/cloudflare.ts` uses `getSysInfo`,
  `RequestProxied.ts` uses `endPoint`/`endPoints`).

## Non-goals (YAGNI)

- **Not** renaming `ts-core/src/utils/SysInfo.ts` — it still legitimately exports
  `getSysInfo`; renaming would churn unrelated import paths (`utils/index.ts`,
  `loggers/implementations/cloudflare.ts`, `SysInfo.test.ts`, ...) for no behavior
  gain.
- **Not** changing the non-deprecated functions (`endPoint`, `endPoints`,
  `serializeResponse`, `getSysInfo`), their signatures, or behavior.
- **Not** introducing a deprecation grace period — removal is immediate.

## Changes by symbol

### 1. `SysInfo` — `ts-core/src/utils/SysInfo.ts`

- Delete the `export const SysInfo = { get: getSysInfo }` block (the trailing
  `@deprecated` export).
- `ts-core/src/utils/index.ts` — drop `SysInfo` from the re-export on the
  `export { getSysInfo, SysInfo } from "./SysInfo"` line; keep `getSysInfo`.
- `ts-core/src/loggers/common/index.ts`:
  - import `getSysInfo` instead of `SysInfo`,
  - `telemetryCache.value` type `ReturnType<typeof SysInfo.get>` →
    `ReturnType<typeof getSysInfo>`,
  - call site `SysInfo.get()` → `getSysInfo()`.
- `ts-core/src/loggers/index.test.ts` — replace the 4 `vi.spyOn(SysInfo, "get")`
  call sites with a namespace-import spy:
  - `import * as SysInfoModule from "../utils/SysInfo"`,
  - `vi.spyOn(SysInfoModule, "getSysInfo")`.
  This is the standard Vitest ESM pattern; the wrapper observes the spy through
  the live module binding. Test assertion text mentioning `SysInfo.get()` may be
  updated to `getSysInfo()` for clarity (cosmetic).

### 2. `RequestUnlimited` — `ts-core/src/retrieve/RequestUnlimited.ts`

- Delete the `export const RequestUnlimited = { defaults, endPoint, endPoints }`
  block.
- `ts-core/src/retrieve/index.ts` — drop `RequestUnlimited` from the
  `export { endPoint, endPoints, RequestUnlimited } from "./RequestUnlimited"`
  group; keep `endPoint`/`endPoints` (and the existing `RequestResult` type
  export).
- `ts-core/src/retrieve/RequestUnlimited.test.ts`:
  - drop `RequestUnlimited` from the import; add `DEFAULT_REQUEST_OPTIONS`
    (already exported from the same module),
  - rewrite the two assertions
    `RequestUnlimited.defaults.timeout` → `DEFAULT_REQUEST_OPTIONS.timeout` and
    `(RequestUnlimited.defaults.retry as any).limit` →
    `(DEFAULT_REQUEST_OPTIONS.retry as any).limit`.
- `ts-core/src/retrieve/RequestProxied.test.ts` — drop the `RequestUnlimited: {}`
  key from the `vi.mock("./RequestUnlimited", ...)` factory. The factory already
  provides `endPoint`, `endPoints`, and `DEFAULT_REQUEST_OPTIONS`; the test never
  references the mocked `RequestUnlimited` object.

### 3. `RequestResponseSerialize` — `ts-core/src/retrieve/RequestResponseSerialize.ts`

- Delete the `export const RequestResponseSerialize = { serialize: serializeResponse }`
  block. No production caller exists.
- `ts-core/src/retrieve/index.ts` — drop the
  `export { RequestResponseSerialize } from "./RequestResponseSerialize"` line.
  Keep the `serializeResponse` usage path and the `SerializedResponse` type export.

## Data flow / error handling

No change. Every removed wrapper delegated 1:1 to a function that remains
exported. Telemetry caching (5s TTL), retry/jitter logic, response serialization,
and the `StrictLogger` contract are untouched.

## Testing & verification

- `pnpm verify:fast` (the repo's TS-only fast gate) green.
- The three affected test files pass:
  `ts-core/src/loggers/index.test.ts`,
  `ts-core/src/retrieve/RequestUnlimited.test.ts`,
  `ts-core/src/retrieve/RequestProxied.test.ts`.
- Grep guard — zero non-doc, non-removed-line matches for the deprecated objects:
  - `\bSysInfo\b` (excluding the `SysInfo.ts` filename),
  - `\bRequestUnlimited\b` as an object reference (distinct from
    `RequestUnlimitedCloud` and the `endPoint`/`endPoints` functions),
  - `\bRequestResponseSerialize\b`.
- `README.md` needs no change (documents only the direct functions).
