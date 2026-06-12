# corelib — Roadmap

Durable backlog of deferred ideas and follow-ups. Per `AGENTS.md` → "Working with Antigravity (agy)",
deferred Antigravity suggestions and YAGNI'd scope land here (or in a spec's "Deferred" section) rather
than being lost. One bullet per item: what, why deferred, and the trigger that should revive it.

## Testing

- **Artifact / `dist` black-box smoke layer for integration tests** — build all packages and import each
  via its published `exports` map (the deferred "Approach C"). *Why deferred:* white-box-against-source
  (the chosen v1) catches the bulk of integration risk; YAGNI until a packaging bug bites. *Revive when:*
  an ESM/CJS, `exports`-map, or bundling regression escapes to a consumer. *(agy 🟡, 2026-06-12 divergent
  pass — see `ANTIGRAVITY-TO-CLAUDE.md`.)*
- **Loopback mock server for Rust-native streaming** — a zero-dep Node `net`/`http`/`ws` loopback bound
  to the test lifecycle, with the Rust Alpaca/Yahoo streamers pointed at `localhost:<port>` to replay
  recorded frames deterministically. *Why deferred:* MSW cannot intercept FFI-driven sockets, so v1
  covers streaming in the opt-in live tier only. *Revive when:* deterministic streaming coverage is
  needed in CI; first verify the Rust streamer accepts an endpoint override. *(agy highest-conviction
  suggestion, 2026-06-12.)*

## Tooling / dev-workflow

- **Tighten the rust lint gate** — `lint-all` currently runs `cargo clippy` (warn-only via the rust
  package's `lint` script). *Revive when:* the crate is warning-clean and ready for
  `cargo clippy -- -D warnings` in the fast loop.
