declare global {
    /**
     * Global logger instance, if available.
     */
    var logger: StrictLogger | undefined;
}
/**
 * Method signature for all log levels.
 *
 * @param {string} msg - The log message.
 * @param {Record<string, unknown>} [extras] - Optional metadata to include with the log entry.
 */
type LogMethod = (msg: string, extras?: Record<string, unknown>) => void;
/**
 * StrictLogger Interface
 * Defines a consistent API across all runtimes (Node, Bun, Deno, Cloudflare, etc.)
 * This ensures that logging behavior is predictable and uniform regardless of the deployment target.
 */
interface StrictLogger {
    /** Logs at the 'trace' level (most verbose). */
    trace: LogMethod;
    /** Logs at the 'debug' level. */
    debug: LogMethod;
    /** Logs at the 'info' level (default). */
    info: LogMethod;
    /** Logs at the 'warn' level. */
    warn: LogMethod;
    /** Logs at the 'error' level. */
    error: LogMethod;
    /** Logs at the 'fatal' level (highest priority). */
    fatal: LogMethod;
    /**
     * Creates a child logger with additional bindings.
     * Child loggers inherit the parent's configuration but add their own metadata.
     *
     * @param {Record<string, unknown>} bindings - Metadata to bind to all logs from the child logger.
     * @returns {StrictLogger} A new logger instance.
     */
    child: (bindings: Record<string, unknown>) => StrictLogger;
    /**
     * Enables or disables system telemetry injection in log entries.
     *
     * @param {"on" | "off"} mode - The telemetry mode.
     */
    setTelemetry: (mode: "on" | "off") => void;
    /** Current log level as a string (e.g., 'info', 'debug'). */
    level: string;
    /** Current log level as a numeric value. */
    levelVal: number;
    /**
     * Returns the current bindings of the logger.
     * @returns {Record<string, unknown>} The current bindings.
     */
    bindings: () => Record<string, unknown>;
    /**
     * Sets the log level to 'silent', disabling all output.
     */
    silent: () => void;
    /**
     * Flush any buffered log output (e.g. pino's sonic-boom buffer).
     * Safe to call as a no-op when no buffer is in use.
     *
     * @param {(err?: Error | null) => void} [cb] - Optional callback called after flushing.
     */
    flush: (cb?: (err?: Error | null) => void) => void;
}

export type { LogMethod as L, StrictLogger as S };
