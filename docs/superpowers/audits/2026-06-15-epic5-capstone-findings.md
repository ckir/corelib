# Epic 5 — Capstone Audit Findings

**Date:** 2026-06-15 · **Branch:** `worktree-epic5-capstone-audit` · **Spec:** `docs/superpowers/specs/2026-06-14-epic5-capstone-audit-design.md`

Gated-hybrid audit across 5 clusters: each suspected weakness was reproduced with a durable probe; only confirmed **hard-gate criticals were fixed inline**, the rest backlogged. Source of record: `.agent/audit_scratchpad.json` (9 findings).

## Outcome summary

- **2 hard-gate criticals fixed inline:**
  - 🔴 **`ffi-tsfn-queue-unbounded`** (Cluster 1) — the streaming `ThreadsafeFunction`s were unbounded (napi `max_queue_size=0`), so a stalled JS consumer pools native off-heap memory without limit. **Fixed:** bounded the high-rate TSFNs to `max_queue_size=1024` (NonBlocking drop-on-overflow), via the inline const-generic (JS callback contract preserved). Commits `bea6067d`→`1aedbcf0`.
  - 🔴 **`dep-supply-chain-audit`** (Cluster 5) — production `axios@0.21.4` (SSRF + credential-leakage, CSRF, NO_PROXY bypass, prototype-pollution auth-bypass) via a **vestigial** `@alpacahq/alpaca-trade-api` (imported nowhere). **Fixed:** pruned the dead dep → high vulns 14→4, all prod axios advisories gone. Commit `bdf841e8`.
- **Clusters confirmed CLEAN** (no defect): shutdown/Drop under reconnect churn (50×), multi-host churn (1000×), redb growth under subscribe/unsubscribe churn (2000×), router input-safety (injection + secret-redaction).
- **Soak/leak: confirmed NOT a leak** — 90s/180s constrained-heap soaks show V8 heap flat; native RSS plateaus (~6–11MB allocator high-water, does not scale with throughput).
- **1 medium backlog** (correlation-ID) + **1 test-harness gap** (loopback delivery) recorded.

## Ranked findings

| # | id | zone | severity | confidence | disposition |
|---|----|------|----------|------------|-------------|
| 1 | `ffi-tsfn-queue-unbounded` | ffi | high | confirmed-by-probe | **FIXED** (cap 1024, NonBlocking drop) |
| 2 | `dep-supply-chain-audit` | facade | high | confirmed-by-reading | **FIXED** (axios pruned); transitive (@grpc/grpc-js, esbuild, protobufjs, uuid) → backlog |
| 3 | `correlation-id-absent` | ffi | medium | confirmed-by-reading | **BACKLOG** — thread explicit trace_id through `#[napi]` into flight events (not ALS/TLS) |
| 4 | `probe-harness-loopback-no-delivery` | ffi | low | confirmed-by-probe | test-harness gap (ws:// tokio-tungstenite↔node-ws); prod wss:// unaffected |
| 5 | `lifecycle-shutdown-exit` | engine | low | confirmed-by-probe | CLEAN — Drop sound under mid-reconnect teardown (50×) |
| 6 | `lifecycle-multi-host-churn` | engine | low | confirmed-by-probe | CLEAN — per-instance redb, no lock cascade / handle exhaustion (1000×) |
| 7 | `redb-growth-bounded` | engine | low | confirmed-by-probe | CLEAN — redb reuses free pages, 0 growth (2000×) |
| 8 | `soak-native-rss-growth` | engine | low | confirmed-by-probe | NOT A LEAK — allocator high-water plateau; V8 heap flat |
| 9 | `router-input-safety` | facade | low | confirmed-by-probe | CLEAN — no crash / no secret leak under injection+malformed input |

## Durable probes (regression guards)

- `probes/js/tsfn-backpressure.probe.test.ts` (+ child) — native-memory TSFN backpressure.
- `probes/js/transport-backpressure.probe.test.ts` (+ child) — real-streamer transport (delivery-capable env).
- `probes/rust/tests/shutdown_exit_under_load.rs`, `multi_host_churn.rs`, `redb_growth.rs` — lifecycle/persistence.
- `probes/js/correlation-id.probe.test.ts` — design probe.
- `probes/_harness/soak-runner.mjs` + `soak-child.mjs` — constrained-heap soak (warms the latency ring before baseline so it isolates real leaks). Run via `heavy-probes.yml --ref <branch> -f probe="js:probes/_harness/soak-runner.mjs --rate 20000 --duration 90000"`.
- `probes/js/router-input-safety.probe.test.ts` — router security.

## Definition of Done

- ✅ All 5 clusters probed (FFI seam / lifecycle / soak-leak / arch+correlation / routers+deps+clippy).
- ✅ Every confirmed hard-gate finding fixed inline (TSFN bound; axios prune) or escalated/clarified (soak = not-a-leak).
- ✅ `heavy-probes.yml` runs JS/soak probes on-demand (build-all + binding copy).
- ✅ Rust lint gate tightened to `clippy --all-targets -D warnings`.

## Backlog (deferred, non-hard-gate)

1. `correlation-id-absent` — explicit FFI trace-context threading (observability completeness).
2. Transitive dep advisories: `@grpc/grpc-js` (≥1.14.4), `esbuild` (build-tool, ≥0.28.1), `protobufjs` (≥7.5.8), `uuid` (≥11.1.1); run `cargo-audit` for the Rust side.
3. `probe-harness-loopback-no-delivery` — ws://-loopback delivery interop (or a TLS/raw-WS loopback) so delivery-dependent FFI probes measure locally.
4. `soak-native-rss-growth` — optional per-thread tick-buffer reuse to lower the ~10MB allocator high-water under flood.
