import { getDb } from '@/data/db';

import type { MkcMemoryResourceKind } from './mkc-memory-core';

export type MkcMemoryCacheEntry = {
  ownerUserId: string;
  cacheKey: string;
  kind: MkcMemoryResourceKind;
  payload: unknown;
  etag?: string | null;
  checksum?: string | null;
  fetchedAt: number;
  expiresAt?: number | null;
};

type CacheRow = {
  owner_user_id: string;
  cache_key: string;
  resource_kind: MkcMemoryResourceKind;
  payload_json: string;
  etag: string | null;
  checksum: string | null;
  fetched_at: number;
  expires_at: number | null;
};

export class MkcMemoryCacheError extends Error {
  constructor(readonly code: 'owner_mismatch' | 'corrupt_cache') {
    super(code === 'owner_mismatch' ? 'Memory cache owner mismatch.' : 'Memory cache entry is corrupt.');
    this.name = 'MkcMemoryCacheError';
  }
}

export async function putMkcMemoryCacheEntry(entry: MkcMemoryCacheEntry): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO mkc_memory_cache (
       owner_user_id, cache_key, resource_kind, payload_json, etag, checksum,
       fetched_at, expires_at, last_accessed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_user_id, cache_key) DO UPDATE SET
       resource_kind = excluded.resource_kind,
       payload_json = excluded.payload_json,
       etag = excluded.etag,
       checksum = excluded.checksum,
       fetched_at = excluded.fetched_at,
       expires_at = excluded.expires_at,
       last_accessed_at = excluded.last_accessed_at;`,
    entry.ownerUserId,
    entry.cacheKey,
    entry.kind,
    JSON.stringify(entry.payload),
    entry.etag ?? null,
    entry.checksum ?? null,
    entry.fetchedAt,
    entry.expiresAt ?? null,
    Date.now(),
  );
}

export async function getMkcMemoryCacheEntry(
  ownerUserId: string,
  cacheKey: string,
): Promise<MkcMemoryCacheEntry | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<CacheRow>(
    `SELECT owner_user_id, cache_key, resource_kind, payload_json, etag, checksum,
            fetched_at, expires_at
       FROM mkc_memory_cache
      WHERE owner_user_id = ? AND cache_key = ?;`,
    ownerUserId,
    cacheKey,
  );
  if (!row) return null;
  if (row.owner_user_id !== ownerUserId) throw new MkcMemoryCacheError('owner_mismatch');
  try {
    return {
      ownerUserId: row.owner_user_id,
      cacheKey: row.cache_key,
      kind: row.resource_kind,
      payload: JSON.parse(row.payload_json) as unknown,
      etag: row.etag,
      checksum: row.checksum,
      fetchedAt: row.fetched_at,
      expiresAt: row.expires_at,
    };
  } catch {
    throw new MkcMemoryCacheError('corrupt_cache');
  }
}

export async function clearMkcMemoryCacheForOwner(ownerUserId: string): Promise<void> {
  if (!ownerUserId.trim()) return;
  const db = await getDb();
  await db.runAsync('DELETE FROM mkc_memory_cache WHERE owner_user_id = ?;', ownerUserId);
}
