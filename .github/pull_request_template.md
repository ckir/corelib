## What and why

<!-- One or two sentences: the problem and how this fixes it. Link an issue if there is one. -->

## Checklist

- [ ] `pnpm verify:fast` passes (format, strict lint, dependency rules, lint, typecheck)
- [ ] `pnpm verify:full` passes (build, browser-bundle check, tests)
- [ ] New behaviour has tests; a bug fix has a test that fails without the fix
- [ ] Public API or behaviour changed: README updated (AGENTS.md section 6)
- [ ] Rust or FFI changed: `cargo clippy -- -D warnings` and `cargo test` pass; `rust/index.js` and `rust/index.d.ts` regenerated and committed
- [ ] Dependencies changed: lockfile updated, `pnpm audit:prod` and `cargo deny check` still pass
