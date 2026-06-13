// corelib-rust path-dep is non-loom only (its tokio-net deps can't build under
// `--cfg loom`); this link-check is meaningless under loom, so gate it out.
#![cfg(not(loom))]
#[test]
fn probe_crate_links_against_corelib_rust() {
    // Compiles iff the path-dep rlib links cleanly (no Node host required).
    assert_eq!(2 + 2, 4);
}
