import * as FileSystem from 'expo-file-system/legacy';

import { getPcmWavDurationsMs, inspectNativeCaptureDirectory } from '@/hardware/recording/foreground';

interface CaptureJournalEvent {
  event?: string;
  wallTimeMs?: number;
  routeRestartCount?: number;
  captureGapMs?: number;
}

export interface NativeCaptureMetrics {
  finalizedUris: string[];
  partialUris: string[];
  recoveredCount: number;
  invalidPartialCount: number;
  journalUri?: string | null;
  audioDurationMs: number;
  wallDurationMs: number;
  startedAt?: number | null;
  stoppedAt?: number | null;
  routeRestartCount: number;
  captureGapMs: number;
  hasStopEvent: boolean;
}

async function readJournalEvents(journalUri?: string | null): Promise<CaptureJournalEvent[]> {
  if (!journalUri) return [];
  const raw = await FileSystem.readAsStringAsync(journalUri).catch(() => '');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as CaptureJournalEvent;
      } catch {
        return null;
      }
    })
    .filter((event): event is CaptureJournalEvent => !!event);
}

export async function getNativeCaptureMetrics(
  directory: string,
  recoverPartials: boolean,
): Promise<NativeCaptureMetrics> {
  const inspection = await inspectNativeCaptureDirectory(directory, recoverPartials);
  const durations = await getPcmWavDurationsMs(inspection.finalizedUris).catch(() => ({} as Record<string, number | null>));
  const events = await readJournalEvents(inspection.journalUri);
  const started = events.find((event) => event.event === 'started')?.wallTimeMs ?? null;
  const stopped = [...events].reverse().find((event) => event.event === 'stopped')?.wallTimeMs ?? null;
  const latestRouteRestartCount = [...events]
    .reverse()
    .find((event) => typeof event.routeRestartCount === 'number')
    ?.routeRestartCount ?? 0;
  const latestCaptureGapMs = [...events]
    .reverse()
    .find((event) => typeof event.captureGapMs === 'number')
    ?.captureGapMs ?? 0;
  const audioDurationMs = inspection.finalizedUris.reduce(
    (sum, uri) => sum + Math.max(0, durations[uri] ?? 0),
    0,
  );
  const wallDurationMs = started && stopped && stopped >= started
    ? stopped - started
    : audioDurationMs;

  return {
    finalizedUris: inspection.finalizedUris,
    partialUris: inspection.partialUris,
    recoveredCount: inspection.recoveredCount,
    invalidPartialCount: inspection.invalidPartialCount,
    journalUri: inspection.journalUri,
    audioDurationMs,
    wallDurationMs,
    startedAt: started,
    stoppedAt: stopped,
    routeRestartCount: latestRouteRestartCount,
    captureGapMs: latestCaptureGapMs,
    hasStopEvent: !!stopped,
  };
}
