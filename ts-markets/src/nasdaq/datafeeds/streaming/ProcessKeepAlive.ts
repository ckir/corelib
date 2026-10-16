// =============================================
// FILE: ts-markets/src/nasdaq/datafeeds/streaming/ProcessKeepAlive.ts
// PURPOSE: Keeps the Node event loop alive while a native streaming feed is running.
// The native callbacks (ThreadsafeFunctions) are unref'd so that a streamer that was only
// constructed, or has been stopped, lets the process exit. A running feed is driven by native
// threads and sockets that Node cannot see, so a script that only waits for ticks would exit
// immediately; this holds one ref'd timer from start() until stop()/clean().
// =============================================

/** One ref'd no-op timer, held while a feed is running. Idempotent in both directions. */
export class ProcessKeepAlive {
	private timer: ReturnType<typeof setInterval> | null = null;

	/** Keep the process alive. Call once the native feed has started. */
	hold(): void {
		if (this.timer) return;
		// 2 ** 30 ms (about 12 days) stays below the 2 ** 31 - 1 ms timer limit; it never needs to fire.
		this.timer = setInterval(() => {}, 2 ** 30);
	}

	/** Let the process exit again. Call when the feed stops. */
	release(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	get held(): boolean {
		return this.timer !== null;
	}
}
