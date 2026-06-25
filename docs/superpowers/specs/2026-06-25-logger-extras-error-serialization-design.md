# Auto-Serialize Errors in Logger `extras` — Design

**Date:** 2026-06-25
**Status:** Approved (design)
**Scope:** `ts-core/src/loggers/*`

## Goal

Make `StrictLogger` automatically serialize `Error` instances placed anywhere in
its `extras` field, using the `serialize-error` package. Today a raw `Error` in
`extras` spreads to `{}` (its `message`/`stack` are non-enumerable), so the error
is silently lost unless the caller remembered to call `serializeError(e)` first
(the convention documented in `AGENTS.md`). This change makes correct
serialization automatic and foolproof while keeping every existing call site
working unchanged.

## Decision

**Deep recursive scan** (user-chosen) via **one shared pure helper**, applied at
every `extras`-spreading site. `serialize-error@^13.0.1` is already a direct
`ts-core` dependency, already externalized in both `tsup.config.ts` files, and
already present in the edge bundle (via `retrieve/*`) — so there is no new bundle
weight.

## Architecture

New file: `ts-core/src/loggers/common/normalize-extras.ts`, exporting
`normalizeExtras`. Applied at the **three** distinct `...extras` spread sites:

| Site | File | Current | After |
|---|---|---|---|
| Pino wrapper (node/bun/deno/lambda/gcp) | `loggers/common/index.ts` (6 methods, lines ~139-180) | `{ ...this.context, ...extras, telemetry: … }` | `{ ...this.context, ...normalizeExtras(extras), telemetry: … }` |
| Cloudflare (bespoke) | `loggers/implementations/cloudflare.ts:62` | `...extras,` | `...normalizeExtras(extras),` |
| Browser (bespoke) | `loggers/implementations/browser.ts:49` | `{ ...this.ctx, ...extras }` | `{ ...this.ctx, ...normalizeExtras(extras) }` |

No change to the `StrictLogger` interface, the public method signatures, or
`validate()`. The Pino-based implementations (node, bun, deno, lambda, gcp) all
wrap `StrictLoggerWrapper`, so patching it covers all five; Cloudflare and Browser
are the only bespoke spreaders.

## `normalizeExtras` contract

Signature: `normalizeExtras(extras: unknown): Record<string, unknown> | undefined`

(The param is `unknown`, not `Record<string, unknown>`, to honor the runtime
reality that the TS type can be bypassed — e.g. an `Error` passed directly.)

Behavior, assuming the logger's `validate()` has already run (so `extras` is one
of: `undefined`, a non-null non-array object, or — via type-bypass — an `Error`):

1. **`undefined` → `undefined`.** So `...normalizeExtras(undefined)` spreads
   nothing.
2. **`extras` is itself an error** (`isError(extras)` true) → return
   `{ err: serializeError(extras) }`. Key is `err` (pino's conventional error key).
3. **Otherwise** deep-clone the structure, replacing every detected error:
   - **Error detection** — `isError(value)` ≡
     `value instanceof Error || Object.prototype.toString.call(value) === "[object Error]"`.
     The second disjunct catches cross-realm errors that fail `instanceof`.
   - On an error value → replace with `serializeError(value)` and **do not descend
     into it** (`serialize-error` already deep-serializes that error's own `cause`
     / `AggregateError` chain).
   - **Recurse only into plain objects** (prototype is `Object.prototype` or
     `null`) **and arrays**, to any depth. **Non-plain objects** (Date, Map, Set,
     Buffer, RegExp, class instances, etc.) are passed through **by reference,
     untouched** — this is the deliberate boundary on "any depth": an error buried
     inside a non-plain class instance is left alone, avoiding mangling exotic or
     cyclic exotic objects.
   - **Cycle safety** — a `Map<originalContainer, clone>` memo: revisiting a
     container returns its existing clone, preserving shared references and
     breaking cycles without infinite recursion.
   - **No mutation** — the caller's `extras` object is never modified; a new
     structure is returned.

`isError` and `normalizeExtras` both live in `normalize-extras.ts`.

## Data flow

`logger.error("msg", extras)` → `validate(msg, extras)` (unchanged) →
`normalizeExtras(extras)` → spread into the destination object alongside
`context`/`telemetry` → underlying sink (pino / `console.log` / `console.*`).

`context` and `telemetry` are **not** normalized — they are internal /
developer-controlled bindings, out of scope (YAGNI). Only caller-supplied `extras`
is scanned.

## Backward compatibility

Fully idempotent with the existing convention. Call sites already doing
`{ error: serializeError(e) }` pass a **plain object** (not an `Error` instance),
so `isError` is false → it is cloned but otherwise unchanged. No
double-serialization; all current call sites keep producing identical output.

## Error handling

`normalizeExtras` is pure and total — it never throws for the inputs `validate()`
permits. `serializeError` is only ever called on a confirmed error value. Exotic
objects are passed through rather than traversed, so no `serialize-error` edge
cases on non-errors are hit.

## Testing

**Unit — `normalize-extras.test.ts`:**
- top-level `{ error: new Error("x") }` → `error` is a serialized object with
  `name`/`message`/`stack`.
- error nested in a plain object: `{ a: { b: new Error() } }` → serialized at depth.
- error nested in an array: `{ list: [new Error()] }` → serialized.
- `extras` is itself an `Error` → `{ err: { name, message, stack, … } }`.
- cyclic structure (`const o = {}; o.self = o`) → returns without hanging.
- already-serialized plain object (`{ error: serializeError(e) }`) → unchanged
  (no double-serialize).
- non-error values (string/number/Date/plain object) → preserved.
- `undefined` → `undefined`.
- cross-realm error simulation (object with `[object Error]` tag) → serialized.
- caller's original object is not mutated.

**Integration — per logger path:** assert that logging `{ err: new Error("boom") }`
through (a) the Pino `StrictLoggerWrapper`, (b) `CloudflareLogger`, and (c)
`BrowserLogger` yields output whose `err`/`error` contains `message` and `stack`
(not `{}`). Reuse the existing logger test harnesses.

**Regression:** the full existing `ts-core` logger suites must stay green.

**Gate:** `pnpm verify:fast` + `pnpm -C ts-core test:run`.

## Docs

Update `AGENTS.md` lines 14-15: raw `Error` objects in `extras` are now
**automatically** serialized by the logger; an explicit `serializeError()` call is
optional and remains a harmless no-op. Keep encouraging structured named keys.

## Non-goals (YAGNI)

- Not normalizing `context`/`child` bindings or `telemetry`.
- Not recursing into non-plain class instances.
- Not changing `validate()`, the `StrictLogger` interface, or method signatures.
- Not removing existing manual `serializeError()` call sites (they stay valid).
