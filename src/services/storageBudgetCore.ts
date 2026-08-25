export type StorageStage = 'record' | 'repass' | 'export';

export interface StorageSnapshot {
  availableBytes: number;
  totalBytes: number;
}

export interface StorageDecision {
  ok: boolean;
  snapshot: StorageSnapshot;
  minimumBytes: number;
  message?: string;
}

const GiB = 1024 * 1024 * 1024;
const MiB = 1024 * 1024;

export const STORAGE_THRESHOLDS: Record<StorageStage, number> = {
  record: 512 * MiB,
  repass: 256 * MiB,
  export: 128 * MiB,
};

export const STORAGE_WARN_BYTES = 1 * GiB;

export function formatStorageBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value >= GiB) return `${(value / GiB).toFixed(1)} GB`;
  if (value >= MiB) return `${Math.round(value / MiB)} MB`;
  return `${Math.round(value / 1024)} KB`;
}

export function evaluateStorageBudget(stage: StorageStage, snapshot: StorageSnapshot): StorageDecision {
  const minimumBytes = STORAGE_THRESHOLDS[stage];
  if (snapshot.availableBytes >= minimumBytes) {
    return { ok: true, snapshot, minimumBytes };
  }

  const message =
    stage === 'record'
      ? `Maina needs at least ${formatStorageBytes(minimumBytes)} free before starting a reliable meeting recording.`
      : stage === 'repass'
        ? `Maina needs at least ${formatStorageBytes(minimumBytes)} free before retrying transcription from saved audio.`
        : `Maina needs at least ${formatStorageBytes(minimumBytes)} free before creating an export file.`;
  return { ok: false, snapshot, minimumBytes, message };
}
