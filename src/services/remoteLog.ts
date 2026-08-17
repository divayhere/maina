/**
 * Remote log sink → Supabase. Streams every structured log entry to a
 * `device_logs` table so the maintainer can watch what the app did in near
 * real time (query the table directly). Best-effort and non-blocking: it
 * batches, never throws, and re-queues on network failure.
 */
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

import { log, type LogEntry } from './logger';
import { REMOTE_LOG } from './remoteConfig';

interface Payload {
  ts: string;
  level: string;
  scope: string;
  message: string;
  context: Record<string, unknown> | null;
  session_id: string;
  app_version: string;
  device: string;
  platform: string;
}

let sessionId = '';
let base: Pick<Payload, 'session_id' | 'app_version' | 'device' | 'platform'> | null = null;
const queue: Payload[] = [];
let flushing = false;
let installed = false;

async function flush(): Promise<void> {
  if (flushing || queue.length === 0 || !REMOTE_LOG.enabled) return;
  flushing = true;
  const batch = queue.splice(0, 50);
  try {
    await fetch(`${REMOTE_LOG.url}/rest/v1/device_logs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: REMOTE_LOG.anonKey,
        Authorization: `Bearer ${REMOTE_LOG.anonKey}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(batch),
    });
  } catch {
    // Network hiccup — put them back and try next tick.
    queue.unshift(...batch);
  } finally {
    flushing = false;
  }
}

export function installRemoteLog(): void {
  if (installed || !REMOTE_LOG.enabled) return;
  installed = true;

  sessionId = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  base = {
    session_id: sessionId,
    app_version: Constants.expoConfig?.version ?? '?',
    device: `${Device.manufacturer ?? ''} ${Device.modelName ?? ''}`.trim() || 'unknown',
    platform: `${Platform.OS} ${Device.osVersion ?? ''}`.trim(),
  };

  log.addSink((e: LogEntry) => {
    queue.push({
      ts: new Date(e.ts).toISOString(),
      level: e.level,
      scope: e.scope,
      message: e.message,
      context: e.context ?? null,
      ...base!,
    });
    if (queue.length >= 15) flush();
  });

  setInterval(flush, 4000);
  log.info('remote', 'remote logging on', { session: sessionId });
}
