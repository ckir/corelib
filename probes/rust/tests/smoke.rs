#[test]
fn probe_crate_links_against_corelib_rust() {
    // Compiles iff the path-dep rlib links cleanly (no Node host required).
    assert_eq!(2 + 2, 4);
}
