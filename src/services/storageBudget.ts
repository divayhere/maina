import * as FileSystem from 'expo-file-system/legacy';

import { log } from './logger';
import {
  evaluateStorageBudget,
  formatStorageBytes,
  STORAGE_THRESHOLDS,
  STORAGE_WARN_BYTES,
  type StorageDecision,
  type StorageSnapshot,
  type StorageStage,
} from './storageBudgetCore';

export {
  evaluateStorageBudget,
  formatStorageBytes,
  STORAGE_THRESHOLDS,
  STORAGE_WARN_BYTES,
  type StorageDecision,
  type StorageSnapshot,
  type StorageStage,
};

export async function getStorageSnapshot(): Promise<StorageSnapshot> {
  const [availableBytes, totalBytes] = await Promise.all([
    FileSystem.getFreeDiskStorageAsync(),
    FileSystem.getTotalDiskCapacityAsync(),
  ]);
  return { availableBytes, totalBytes };
}

export async function ensureStorageBudget(stage: StorageStage): Promise<StorageDecision> {
  const snapshot = await getStorageSnapshot();
  const decision = evaluateStorageBudget(stage, snapshot);
  if (decision.ok && snapshot.availableBytes < STORAGE_WARN_BYTES) {
    log.warn('storage', 'free space is getting low', {
      stage,
      availableBytes: snapshot.availableBytes,
      minimumBytes: decision.minimumBytes,
    });
  }
  if (!decision.ok) {
    log.warn('storage', 'storage preflight blocked action', {
      stage,
      availableBytes: snapshot.availableBytes,
      minimumBytes: decision.minimumBytes,
    });
  }
  return decision;
}
