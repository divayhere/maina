/**
 * Watchdog — net #2 of 3 (structured local log).
 * Net #1 is optional Sentry crash capture; net #3 is the error-boundary UI.
 *
 * Everything meaningful the app does flows through here: record started,
 * mic = X, transcribe took Ns, audio deleted, provider call failed. A rolling
 * in-memory ring buffer is also streamed into the native durable Supabase outbox.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  scope: string;
  message: string;
  context?: Record<string, unknown>;
}

const RING_SIZE = 2000;

const SENSITIVE_KEY = /(?:key|token|authorization|transcript|audioUri|audio_uri|path|dsn)/i;

function safeContext(context?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!context) return undefined;
  return Object.fromEntries(
    Object.entries(context).map(([key, value]) => [
      key,
      SENSITIVE_KEY.test(key) ? '[redacted]' : value instanceof Error ? value.message : value,
    ]),
  );
}

class Logger {
  private ring: LogEntry[] = [];
  private sinks: ((e: LogEntry) => void)[] = [];

  /** Add a sink (console now; Sentry breadcrumb sink added later). */
  addSink(sink: (e: LogEntry) => void) {
    this.sinks.push(sink);
  }

  private emit(level: LogLevel, scope: string, message: string, context?: Record<string, unknown>) {
    const entry: LogEntry = { ts: Date.now(), level, scope, message, context: safeContext(context) };
    this.ring.push(entry);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    for (const s of this.sinks) {
      try { s(entry); } catch { /* a broken sink must never break the app */ }
    }
  }

  debug = (scope: string, msg: string, ctx?: Record<string, unknown>) => this.emit('debug', scope, msg, ctx);
  info = (scope: string, msg: string, ctx?: Record<string, unknown>) => this.emit('info', scope, msg, ctx);
  warn = (scope: string, msg: string, ctx?: Record<string, unknown>) => this.emit('warn', scope, msg, ctx);
  error = (scope: string, msg: string, ctx?: Record<string, unknown>) => this.emit('error', scope, msg, ctx);

  /** Full buffer as text — backs the one-tap export. */
  dump(): string {
    return this.ring
      .map((e) => {
        const t = new Date(e.ts).toISOString();
        const ctx = e.context ? ' ' + JSON.stringify(e.context) : '';
        return `${t} [${e.level.toUpperCase()}] ${e.scope}: ${e.message}${ctx}`;
      })
      .join('\n');
  }

  recent(): LogEntry[] {
    return [...this.ring];
  }
}

export const log = new Logger();

// Console remains useful during local development; Sentry and the native outbox augment it.
log.addSink((e) => {
  const line = `[${e.scope}] ${e.message}`;
  if (e.level === 'error') console.error(line, e.context ?? '');
  else if (e.level === 'warn') console.warn(line, e.context ?? '');
  else console.log(line, e.context ?? '');
});
