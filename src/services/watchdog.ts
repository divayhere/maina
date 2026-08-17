/**
 * Watchdog wiring: captures uncaught JS errors into the logger and persists the
 * log to disk so it survives a crash/restart. Net #3 (error boundary) lives in
 * design/ErrorBoundary. Remote reporting (Sentry) is added in a later phase.
 */
import * as FileSystem from 'expo-file-system/legacy';

import { log, type LogEntry } from './logger';

export const LOG_FILE = `${FileSystem.documentDirectory}maina-last-log.txt`;

let installed = false;
let writeScheduled = false;

function persistSoon() {
  if (writeScheduled) return;
  writeScheduled = true;
  setTimeout(() => {
    writeScheduled = false;
    FileSystem.writeAsStringAsync(LOG_FILE, log.dump()).catch(() => {});
  }, 400);
}

export function installWatchdog(): void {
  if (installed) return;
  installed = true;

  // Persist whenever something notable happens.
  log.addSink((e: LogEntry) => {
    if (e.level === 'error' || e.level === 'warn') persistSoon();
  });

  // Catch uncaught JS errors.
  const g = globalThis as unknown as {
    ErrorUtils?: {
      getGlobalHandler?: () => (e: unknown, isFatal?: boolean) => void;
      setGlobalHandler?: (h: (e: unknown, isFatal?: boolean) => void) => void;
    };
  };
  const prev = g.ErrorUtils?.getGlobalHandler?.();
  g.ErrorUtils?.setGlobalHandler?.((err: unknown, isFatal?: boolean) => {
    const e = err as { message?: string; stack?: string };
    log.error('crash', e?.message ?? String(err), { isFatal, stack: e?.stack });
    FileSystem.writeAsStringAsync(LOG_FILE, log.dump()).catch(() => {});
    prev?.(err, isFatal);
  });

  log.info('watchdog', 'installed');
}

export async function readPersistedLog(): Promise<string> {
  try {
    const info = await FileSystem.getInfoAsync(LOG_FILE);
    if (!info.exists) return '';
    return await FileSystem.readAsStringAsync(LOG_FILE);
  } catch {
    return '';
  }
}
