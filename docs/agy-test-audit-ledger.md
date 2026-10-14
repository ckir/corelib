# agy-test-audit ledger

One row per audit run. Newest row at the BOTTOM. Escape every `|` inside a cell as `\|`. The range column starts with the audited range; its right-hand end is the last commit the audit covered. This is a RECORD, not a proof.

| Date | Range (audited tip is the right-hand end) | Rounds | Verdict | Evidence |
|---|---|---|---|---|
| 2026-10-14 | `e0058c67..ac81cb44` | 1 (3 chunks) | GAPS FOUND, all dispositioned | Briefs `.clavity/seams/test-audit-{core,markets-cloud,rust-tooling}.md`, report `.clavity/scratch/test-audit/report.md`. G1 (includeExcludeCron never fired) FOLDED f8eaf64d + 24e67343; G2 FOLDED e763d016; G3, G4, G5 FOLDED a81272c8; every new test mutant-proved red. Rust CLI exit paths, check-browser-bundle exit codes, cloudrun server.ts DEFERRED-TO-ROADMAP (ROADMAP.md Testing, 9cd802e9). REJECTED by measurement: Alpaca native-init wrap (AlpacaStreaming.ffi-error.test.ts:37), decryptConfig untested (ConfigUtils.test.ts), smoke probe tautology and tsfn soft oracle (by design), INTEGRATION_LIVE gating (by design). DISCARDED-BELOW-FLOOR: cloudflare worker env forwarding (worker.ts one-line passthrough, router.auth.test.ts). Source change re-capstoned: see agy-capstone ledger row bdb4c1e5..ac81cb44. |
