import { getDb, withDurableWakeTransaction } from './db';

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export type MeetingDiscardTombstone = {
  meetingId: string;
  discardId: string;
  captureDirectory: string;
  qualificationEvidenceDigest: string | null;
  captureGeneration: number;
  requestedAt: number;
};

type TombstoneRow = {
  meeting_id: string;
  discard_id: string;
  capture_directory: string;
  qualification_evidence_digest: string | null;
  capture_generation: number;
  requested_at: number;
};

function validate(input: MeetingDiscardTombstone): MeetingDiscardTombstone {
  if (!ID.test(input.meetingId) || !ID.test(input.discardId)) throw new Error('meeting_discard_identity_invalid');
  if (!input.captureDirectory || input.captureDirectory.length > 4096) {
    throw new Error('meeting_discard_directory_invalid');
  }
  if (input.qualificationEvidenceDigest != null && !SHA256.test(input.qualificationEvidenceDigest)) {
    throw new Error('meeting_discard_qualification_invalid');
  }
  if (!Number.isSafeInteger(input.captureGeneration) || input.captureGeneration < 0) {
    throw new Error('meeting_discard_generation_invalid');
  }
  if (!Number.isSafeInteger(input.requestedAt) || input.requestedAt < 1) {
    throw new Error('meeting_discard_time_invalid');
  }
  return input;
}

function decode(row: TombstoneRow): MeetingDiscardTombstone {
  return validate({
    meetingId: row.meeting_id,
    discardId: row.discard_id,
    captureDirectory: row.capture_directory,
    qualificationEvidenceDigest: row.qualification_evidence_digest,
    captureGeneration: row.capture_generation,
    requestedAt: row.requested_at,
  });
}

/**
 * Atomically makes the meeting logically absent while retaining a standalone
 * replay record until native audio/control deletion is exactly acknowledged.
 */
export async function commitMeetingDiscard(input: MeetingDiscardTombstone): Promise<void> {
  const value = validate(input);
  await withDurableWakeTransaction(async (transaction) => {
    const existing = await transaction.getFirstAsync<TombstoneRow>(
      'SELECT * FROM meeting_discard_tombstones WHERE meeting_id = ? OR discard_id = ?',
      [value.meetingId, value.discardId],
    );
    if (existing) {
      const decoded = decode(existing);
      if (JSON.stringify(decoded) !== JSON.stringify(value)) throw new Error('meeting_discard_identity_conflict');
    } else {
      await transaction.runAsync(
        `INSERT INTO meeting_discard_tombstones
          (meeting_id, discard_id, capture_directory, qualification_evidence_digest, capture_generation, requested_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          value.meetingId,
          value.discardId,
          value.captureDirectory,
          value.qualificationEvidenceDigest,
          value.captureGeneration,
          value.requestedAt,
        ],
      );
    }
    await transaction.runAsync('DELETE FROM meetings WHERE id = ?', [value.meetingId]);
  });
}

export async function listMeetingDiscardTombstones(): Promise<MeetingDiscardTombstone[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<TombstoneRow>(
    'SELECT * FROM meeting_discard_tombstones ORDER BY requested_at ASC, meeting_id ASC',
  );
  return rows.map(decode);
}

export async function completeMeetingDiscard(meetingId: string, discardId: string): Promise<void> {
  if (!ID.test(meetingId) || !ID.test(discardId)) throw new Error('meeting_discard_identity_invalid');
  await withDurableWakeTransaction(async (transaction) => {
    const existing = await transaction.getFirstAsync<TombstoneRow>(
      'SELECT * FROM meeting_discard_tombstones WHERE meeting_id = ?',
      [meetingId],
    );
    if (!existing) return;
    if (existing.discard_id !== discardId) throw new Error('meeting_discard_identity_conflict');
    const result = await transaction.runAsync(
      'DELETE FROM meeting_discard_tombstones WHERE meeting_id = ? AND discard_id = ?',
      [meetingId, discardId],
    );
    if (result.changes !== 1) throw new Error('meeting_discard_completion_failed');
  });
}
