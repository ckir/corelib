# agy-capstone ledger

One row per capstone run. The range column starts with the reviewed range; its right-hand end is the reviewed tip.

| Date | Range (reviewed tip is the right-hand end) | Subject | Rounds | Notes |
|---|---|---|---|---|
| 2026-10-14 | `e0058c67..bdb4c1e5` | corelib review fixes, strict TS, CI/tooling | 3 | Round 1: five chunks (cloud, core, markets, rust, tooling), every finding measured; folds 6b2c95bc, 166f94bc, 26a932af, 0cd5d2e9, bdb4c1e5 (+ test fix b52939bc). Rounds 2 and 3: fold audit of 30d3d3b5..bdb4c1e5 (round 3 with rotated seats), both CLEAN; round-3 revert mutants a1-a3, b1-b3, d1-d2 measured RED. Isolation: SHARED-CONTEXT (the SQLite transaction design consult for 26a932af shared a cascade with the reviews). GREEN adjudicated by the user. Rejected on measurement: SAM HttpApi CORS, CI double test run, ts-cloud to ts-markets cruiser rule, browser-bundle cwd. Round-3 correction: NasdaqPolling stop() is safe because the first stop() already bumps the generation, not because no tick can run with a null interval. Owner accepted tokio-tungstenite rustls-webpki-roots. |
