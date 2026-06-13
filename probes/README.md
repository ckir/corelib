# /probes — Durable Audit Probe Harnesses

## Purpose

This directory contains long-lived audit probes for the `corelib` monorepo. These are
**not** throwaway scripts — they are kept and evolved over time as part of an ongoing
audit of races, performance, architecture, and edge-case correctness.

Probes assert **behavioral outcomes** (observable behavior of the system regardless of
how the underlying binary is structured), never code or binary structure. A probe that
asserts an internal implementation detail is wrong; a probe that asserts a contract
observable at the API/wire boundary is correct.

## Running the Probes

**JS probes (vitest):**
```
pnpm exec vitest run -c probes/vitest.config.ts
```

**Rust probes (cargo):**
```
cargo test --manifest-path probes/rust/Cargo.toml
```

The first Rust probe build will be slow — it compiles `corelib-rust` as an rlib. Subsequent
runs use the cached build under `probes/rust/target/` (gitignored).

## Directory Layout

```
probes/
  vitest.config.ts          # Dedicated vitest config (scoped to /probes only)
  js/                        # JS/TS probes (*.probe.test.ts)
    smoke.probe.test.ts      # Baseline isolation smoke test
  _harness/                  # Shared harness utilities (*.test.ts scanned here)
  rust/
    Cargo.toml               # Standalone crate (corelib-probes)
    src/lib.rs
    tests/
      smoke.rs               # Baseline link smoke test
```

## Isolation Guarantees

### Rust isolation
`probes/rust/` is a **standalone Cargo crate**, NOT part of any Cargo workspace.
`rust/Cargo.toml` (the production crate) is a single crate, not a workspace — so
`cargo test` in `rust/` will never discover or compile `probes/rust/`. The probe
crate links `corelib-rust` via a path dependency (`../../rust`), exercising the
`rlib` target without requiring the Node host (`cdylib` / napi bindings).

### JS isolation
`probes/vitest.config.ts` sets `root: __dirname`, scoping all test discovery to
`/probes`. Each package (`ts-core`, `ts-markets`, `ts-cloud`) has its own
`vitest.config.ts` rooted in its own package directory — none of them reach
outside their package boundary into `/probes`.

Running `pnpm -r test:run` will never execute any file under `/probes`.
