export const MEETING_DISCARD_V21_MIGRATION_SQL = `CREATE TABLE meeting_discard_tombstones (
  meeting_id TEXT PRIMARY KEY NOT NULL
    CHECK(length(meeting_id) BETWEEN 1 AND 128),
  singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK(singleton = 1),
  discard_id TEXT UNIQUE NOT NULL
    CHECK(length(discard_id) BETWEEN 1 AND 128),
  capture_directory TEXT NOT NULL
    CHECK(length(capture_directory) BETWEEN 1 AND 4096),
  qualification_evidence_digest TEXT
    CHECK(qualification_evidence_digest IS NULL OR
      (length(qualification_evidence_digest) = 64 AND lower(qualification_evidence_digest) = qualification_evidence_digest)),
  capture_generation INTEGER NOT NULL CHECK(capture_generation >= 0),
  requested_at INTEGER NOT NULL CHECK(requested_at > 0)
) STRICT;`;
