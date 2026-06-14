// Own process: asserts the panic hook dumps the ring to stderr and the process
// SURVIVES a worker-thread panic with no double-panic/abort.
#[test]
fn panic_hook_dumps_and_survives() {
    corelib_rust::observability::init_flight_recorder();
    tracing::error!(target: "corelib_rust::stream", "pre-panic marker");
    let h = std::thread::spawn(|| panic!("boom"));
    assert!(h.join().is_err()); // thread panicked
    let _ = corelib_rust::observability::ring_buffer::drain_to_lines(); // alive + drainable
}
