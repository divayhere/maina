import CryptoKit
import Foundation
import SQLite3

enum MainaNativePostProcessingStoreError: Error, Equatable {
  case invalidInput(String)
  case identityConflict
  case storageFailure(String)
}

struct MainaNativePostProcessingWindowConfig: Codable, Equatable {
  let targetWindowMs: Int
  let analysisOverlapMs: Int
  let maxAttempts: Int
}

struct MainaNativePostProcessingWindowPlan: Codable, Equatable {
  let index: Int
  let audioURI: String
  let audioStartMs: Int
  let audioEndMs: Int
  let coverageStartMs: Int
  let coverageEndMs: Int
  let analysisStartMs: Int
  let analysisEndMs: Int
}

struct MainaNativePostProcessingStart: Equatable {
  let ownerUserId: String
  let meetingId: String
  let runId: String
  let generation: Int
  let audioFingerprintSha256: String
  let contractVersion: String
  let modelId: String
  let modelVersion: String
  let runtimeVersion: String
  let modelManifestSha256: String?
  let modelActivationGeneration: UInt64?
  let runtimeOwnerToken: String
  let audioDurationMs: Int
  let segmentCount: Int
  let windowConfig: MainaNativePostProcessingWindowConfig
  let windows: [MainaNativePostProcessingWindowPlan]
  let createdAtMs: Int64
}

struct MainaNativePostProcessingModelBinding: Equatable {
  let modelId: String
  let modelVersion: String
  let runtimeVersion: String
  let manifestSha256: String?
  let activationGeneration: UInt64?
}

struct MainaNativePostProcessingStartResult: Equatable {
  let resumed: Bool
  let state: String
  let firstIncompleteWindowKey: String?
}

struct MainaNativePostProcessingClaim: Equatable {
  let ownerUserId: String
  let meetingId: String
  let runId: String
  let generation: Int
  let windowKey: String
  let windowIndex: Int
  let audioURI: String
  let audioStartMs: Int
  let audioEndMs: Int
  let coverageStartMs: Int
  let coverageEndMs: Int
  let analysisStartMs: Int
  let analysisEndMs: Int
  let runtimeOwnerToken: String
  let claimNonce: String
  let attemptCount: Int
  let maxAttempts: Int
}

struct MainaNativePostProcessingBlockInput: Equatable {
  let startedAtMs: Int
  let endedAtMs: Int
  let text: String
  let language: String
}

struct MainaNativePostProcessingVadInput: Equatable {
  let status: String
  let evidenceSha256: String
}

struct MainaNativePostProcessingImportFence: Equatable {
  let schemaVersion: String
  let state: String
  let ownerUserId: String
  let meetingId: String
  let runId: String
  let generation: Int
  let resultId: String
  let resultPayloadSha256: String
  let importedAt: String
  let transactionCommitSha256: String
}

/**
 * iOS native post-processing has its own SQLite WAL and never opens Expo's
 * `maina.db`. Every mutation is serialized here and committed with its
 * checkpoint, so process restart can resume the first incomplete window.
 */
final class MainaNativePostProcessingStore {
  private enum Value {
    case text(String)
    case int(Int64)
    case null
  }

  private struct PersistedRun {
    let ownerUserId: String
    let meetingId: String
    let runId: String
    let generation: Int
    let state: String
    let audioFingerprintSha256: String
    let contractVersion: String
    let modelId: String
    let modelVersion: String
    let runtimeVersion: String
    let modelManifestSha256: String?
    let modelActivationGeneration: UInt64?
    let runtimeOwnerToken: String
    let audioDurationMs: Int
    let segmentCount: Int
    let targetWindowMs: Int
    let analysisOverlapMs: Int
    let maxAttempts: Int
    let windowPlanSha256: String
    let createdAtMs: Int64
  }

  private struct PersistedWindow {
    let windowKey: String
    let index: Int
    let coverageStartMs: Int
    let coverageEndMs: Int
    let analysisStartMs: Int
    let analysisEndMs: Int
    let status: String
    let attemptCount: Int
    let reasonCode: String
    let blocksJSON: String?
    let vadStatus: String?
    let vadEvidenceSha256: String?
  }

  private static let identifierPattern = try! NSRegularExpression(
    pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
  )
  private static let shaPattern = try! NSRegularExpression(pattern: "^[a-f0-9]{64}$")
  private static let languagePattern = try! NSRegularExpression(pattern: "^[A-Za-z][A-Za-z0-9-]{1,15}$")
  private static let currentProcessInstanceToken = "process_" + UUID().uuidString
    .replacingOccurrences(of: "-", with: "").lowercased()
  private static let reasonCodes = Set([
    "NONE", "MODEL_UNAVAILABLE", "RUNTIME_INTERRUPTED", "AUDIO_UNREADABLE",
    "RETRY_BUDGET_EXHAUSTED", "OWNER_RELEASED",
  ])
  private static let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

  private let lock = NSRecursiveLock()
  private let processInstanceToken: String
  private var database: OpaquePointer?

  init(databaseURL: URL, processInstanceToken: String = MainaNativePostProcessingStore.currentProcessInstanceToken) throws {
    guard Self.validIdentifier(processInstanceToken) else {
      throw MainaNativePostProcessingStoreError.invalidInput("process_instance_invalid")
    }
    self.processInstanceToken = processInstanceToken
    let parent = databaseURL.deletingLastPathComponent()
    try FileManager.default.createDirectory(
      at: parent,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: parent.path)
    var opened: OpaquePointer?
    let flags = SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX
    guard sqlite3_open_v2(databaseURL.path, &opened, flags, nil) == SQLITE_OK, let opened else {
      throw MainaNativePostProcessingStoreError.storageFailure("database_open_failed")
    }
    database = opened
    sqlite3_busy_timeout(opened, 5_000)
    do {
      try execute("PRAGMA journal_mode=WAL")
      try execute("PRAGMA synchronous=FULL")
      try execute("PRAGMA foreign_keys=ON")
      try createSchema()
      try Self.hardenDatabaseFiles(databaseURL)
      try recoverInterruptedProcessClaims()
    } catch {
      sqlite3_close(opened)
      database = nil
      throw error
    }
  }

  deinit {
    if let database { sqlite3_close(database) }
  }

  static func defaultDatabaseURL() -> URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("Maina", isDirectory: true)
      .appendingPathComponent("native-post-processing", isDirectory: true)
      .appendingPathComponent("maina-native-post-processing.sqlite3")
  }

  private static func hardenDatabaseFiles(_ databaseURL: URL) throws {
    let manager = FileManager.default
    for url in [databaseURL, URL(fileURLWithPath: databaseURL.path + "-wal"), URL(fileURLWithPath: databaseURL.path + "-shm")] {
      if manager.fileExists(atPath: url.path) {
        try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
      }
    }
  }

  func begin(_ input: MainaNativePostProcessingStart) throws -> MainaNativePostProcessingStartResult {
    try validate(input)
    return try lockedTransaction {
      if let persistedOwner = try persistedOwner(meetingId: input.meetingId) {
        guard Self.validIdentifier(persistedOwner), persistedOwner == input.ownerUserId else {
          throw MainaNativePostProcessingStoreError.identityConflict
        }
        guard let existing = try findRun(ownerUserId: input.ownerUserId, meetingId: input.meetingId) else {
          throw MainaNativePostProcessingStoreError.storageFailure("run_record_missing")
        }
        guard exact(existing, matches: input) else {
          throw MainaNativePostProcessingStoreError.identityConflict
        }
        return MainaNativePostProcessingStartResult(
          resumed: true,
          state: existing.state,
          firstIncompleteWindowKey: try firstIncompleteWindowKey(input)
        )
      }

      try execute(
        "INSERT INTO runs (owner_user_id, meeting_id, run_id, generation, state, audio_fingerprint_sha256, "
          + "contract_version, model_id, model_version, runtime_version, model_manifest_sha256, "
          + "model_activation_generation, runtime_owner_token, audio_duration_ms, "
          + "segment_count, target_window_ms, analysis_overlap_ms, max_attempts, window_plan_sha256, created_at, updated_at, event_sequence) "
          + "VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
        [
          .text(input.ownerUserId), .text(input.meetingId), .text(input.runId), .int(Int64(input.generation)),
          .text(input.audioFingerprintSha256), .text(input.contractVersion), .text(input.modelId),
          .text(input.modelVersion), .text(input.runtimeVersion), input.modelManifestSha256.map(Value.text) ?? .null,
          input.modelActivationGeneration.map { .int(Int64($0)) } ?? .null, .text(input.runtimeOwnerToken),
          .int(Int64(input.audioDurationMs)), .int(Int64(input.segmentCount)),
          .int(Int64(input.windowConfig.targetWindowMs)), .int(Int64(input.windowConfig.analysisOverlapMs)),
          .int(Int64(input.windowConfig.maxAttempts)), .text(windowPlanSha256(input)),
          .int(input.createdAtMs), .int(input.createdAtMs),
        ]
      )
      for window in input.windows {
        try execute(
          "INSERT INTO windows (owner_user_id, meeting_id, run_id, generation, window_key, window_index, audio_uri, "
            + "coverage_start_ms, coverage_end_ms, analysis_start_ms, analysis_end_ms, status, attempt_count, "
            + "reason_code, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, 'NONE', ?)",
          [
            .text(input.ownerUserId), .text(input.meetingId), .text(input.runId), .int(Int64(input.generation)),
            .text(windowKey(input: input, window: window)), .int(Int64(window.index)), .text(window.audioURI),
            .int(Int64(window.coverageStartMs)), .int(Int64(window.coverageEndMs)),
            .int(Int64(window.analysisStartMs)), .int(Int64(window.analysisEndMs)), .int(input.createdAtMs),
          ]
        )
      }
      return MainaNativePostProcessingStartResult(
        resumed: false,
        state: "queued",
        firstIncompleteWindowKey: try firstIncompleteWindowKey(input)
      )
    }
  }

  func claimFirstIncomplete(
    _ input: MainaNativePostProcessingStart,
    recordingActive: Bool
  ) throws -> MainaNativePostProcessingClaim? {
    try validateIdentity(input)
    return try lockedTransaction {
      guard try persistedOwner(meetingId: input.meetingId) == input.ownerUserId,
        let run = try findRun(ownerUserId: input.ownerUserId, meetingId: input.meetingId), exact(run, matches: input)
      else {
        throw MainaNativePostProcessingStoreError.identityConflict
      }
      guard !["complete", "partial", "acknowledged"].contains(run.state) else { return nil }
      if recordingActive {
        try preemptForRecordingLocked(input)
        return nil
      }
      guard try runtimeOwnerExists() == false else { return nil }
      guard let window = try firstWindow(input, states: ["queued"]) else {
        try sealIfTerminal(input)
        return nil
      }
      guard window.attemptCount < input.windowConfig.maxAttempts else {
        throw MainaNativePostProcessingStoreError.storageFailure("attempt_budget_inconsistent")
      }
      let attempt = window.attemptCount + 1
      let nonce = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
      let current = nowMs()
      try execute(
        "UPDATE windows SET status = 'running', attempt_count = ?, claim_nonce = ?, reason_code = 'NONE', updated_at = ? "
          + "WHERE owner_user_id = ? AND meeting_id = ? AND run_id = ? AND generation = ? AND window_key = ? AND status = 'queued'",
        [
          .int(Int64(attempt)), .text(nonce), .int(current), .text(input.ownerUserId), .text(input.meetingId),
          .text(input.runId), .int(Int64(input.generation)), .text(window.windowKey),
        ]
      )
      try execute(
        "INSERT INTO attempts (owner_user_id, meeting_id, run_id, generation, window_key, attempt_number, "
          + "runtime_owner_token, claim_nonce, state, reason_code, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', 'NONE', ?)",
        [
          .text(input.ownerUserId), .text(input.meetingId), .text(input.runId), .int(Int64(input.generation)),
          .text(window.windowKey), .int(Int64(attempt)), .text(input.runtimeOwnerToken), .text(nonce), .int(current),
        ]
      )
      try execute(
        "INSERT INTO runtime_owner (singleton, owner_user_id, meeting_id, run_id, generation, window_key, "
          + "runtime_owner_token, claim_nonce, process_instance_token, claimed_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          .text(input.ownerUserId), .text(input.meetingId), .text(input.runId), .int(Int64(input.generation)),
          .text(window.windowKey), .text(input.runtimeOwnerToken), .text(nonce), .text(processInstanceToken), .int(current),
        ]
      )
      try execute(
        "UPDATE runs SET state = 'running', updated_at = ?, event_sequence = event_sequence + 1 "
          + "WHERE owner_user_id = ? AND meeting_id = ? AND run_id = ? AND generation = ?",
        [.int(current), .text(input.ownerUserId), .text(input.meetingId), .text(input.runId), .int(Int64(input.generation))]
      )
      return MainaNativePostProcessingClaim(
        ownerUserId: input.ownerUserId,
        meetingId: input.meetingId,
        runId: input.runId,
        generation: input.generation,
        windowKey: window.windowKey,
        windowIndex: window.index,
        audioURI: try audioURI(input, windowKey: window.windowKey),
        audioStartMs: input.windows[window.index].audioStartMs,
        audioEndMs: input.windows[window.index].audioEndMs,
        coverageStartMs: window.coverageStartMs,
        coverageEndMs: window.coverageEndMs,
        analysisStartMs: window.analysisStartMs,
        analysisEndMs: window.analysisEndMs,
        runtimeOwnerToken: input.runtimeOwnerToken,
        claimNonce: nonce,
        attemptCount: attempt,
        maxAttempts: input.windowConfig.maxAttempts
      )
    }
  }

  func commitWindow(
    claim: MainaNativePostProcessingClaim,
    blocks: [MainaNativePostProcessingBlockInput],
    vad: MainaNativePostProcessingVadInput
  ) throws -> Bool {
    try validateClaim(claim)
    try validateVad(vad)
    try validate(blocks: blocks, claim: claim)
    return try lockedTransaction {
      guard try ownsRuntime(claim) else { return false }
      let encodedBlocks = try makeBlocksJSON(blocks, claim: claim)
      let current = nowMs()
      try execute(
        "UPDATE windows SET status = 'completed', blocks_json = ?, vad_status = ?, vad_evidence_sha256 = ?, "
          + "reason_code = 'NONE', claim_nonce = NULL, updated_at = ? WHERE owner_user_id = ? AND meeting_id = ? "
          + "AND run_id = ? AND generation = ? AND window_key = ? AND status = 'running' AND claim_nonce = ?",
        [
          .text(encodedBlocks), .text(vad.status), .text(vad.evidenceSha256), .int(current),
          .text(claim.ownerUserId), .text(claim.meetingId), .text(claim.runId), .int(Int64(claim.generation)),
          .text(claim.windowKey), .text(claim.claimNonce),
        ]
      )
      try finishAttempt(claim, state: "completed", reasonCode: "NONE", at: current)
      try clearRuntime(claim)
      try execute(
        "UPDATE runs SET state = 'queued', updated_at = ?, event_sequence = event_sequence + 1 WHERE owner_user_id = ? "
          + "AND meeting_id = ? AND run_id = ? AND generation = ?",
        [.int(current), .text(claim.ownerUserId), .text(claim.meetingId), .text(claim.runId), .int(Int64(claim.generation))]
      )
      try sealIfTerminal(claim)
      return true
    }
  }

  func failWindow(claim: MainaNativePostProcessingClaim, reasonCode: String) throws -> Bool {
    try validateClaim(claim)
    guard Self.reasonCodes.contains(reasonCode), reasonCode != "NONE", reasonCode != "OWNER_RELEASED" else {
      throw MainaNativePostProcessingStoreError.invalidInput("reason_code_invalid")
    }
    return try lockedTransaction {
      guard try ownsRuntime(claim) else { return false }
      let terminal = claim.attemptCount >= claim.maxAttempts
      let persistedReason = terminal ? "RETRY_BUDGET_EXHAUSTED" : reasonCode
      let state = terminal ? "failed" : "queued"
      let current = nowMs()
      try execute(
        "UPDATE windows SET status = ?, reason_code = ?, claim_nonce = NULL, updated_at = ? WHERE owner_user_id = ? "
          + "AND meeting_id = ? AND run_id = ? AND generation = ? AND window_key = ? AND status = 'running' AND claim_nonce = ?",
        [
          .text(state), .text(persistedReason), .int(current), .text(claim.ownerUserId), .text(claim.meetingId),
          .text(claim.runId), .int(Int64(claim.generation)), .text(claim.windowKey), .text(claim.claimNonce),
        ]
      )
      try finishAttempt(claim, state: terminal ? "failed" : "retryable", reasonCode: persistedReason, at: current)
      try clearRuntime(claim)
      try execute(
        "UPDATE runs SET state = 'queued', updated_at = ?, event_sequence = event_sequence + 1 WHERE owner_user_id = ? "
          + "AND meeting_id = ? AND run_id = ? AND generation = ?",
        [.int(current), .text(claim.ownerUserId), .text(claim.meetingId), .text(claim.runId), .int(Int64(claim.generation))]
      )
      try sealIfTerminal(claim)
      return true
    }
  }

  func markUnresolved(_ input: MainaNativePostProcessingStart, reasonCode: String) throws {
    try validateIdentity(input)
    guard Self.reasonCodes.contains(reasonCode), reasonCode != "NONE" else {
      throw MainaNativePostProcessingStoreError.invalidInput("reason_code_invalid")
    }
    try lockedTransaction {
      guard try persistedOwner(meetingId: input.meetingId) == input.ownerUserId,
        let run = try findRun(ownerUserId: input.ownerUserId, meetingId: input.meetingId), exact(run, matches: input)
      else {
        throw MainaNativePostProcessingStoreError.identityConflict
      }
      guard try runtimeOwnerExists() == false else {
        throw MainaNativePostProcessingStoreError.storageFailure("runtime_claim_active")
      }
      try execute(
        "UPDATE windows SET status = 'unresolved', reason_code = ?, updated_at = ? WHERE owner_user_id = ? "
          + "AND meeting_id = ? AND run_id = ? AND generation = ? AND status = 'queued'",
        [
          .text(reasonCode), .int(nowMs()), .text(input.ownerUserId), .text(input.meetingId),
          .text(input.runId), .int(Int64(input.generation)),
        ]
      )
      try sealIfTerminal(input)
    }
  }

  func setRecordingActive(_ active: Bool) throws {
    try lockedTransaction {
      if active {
        guard let claim = try currentRuntimeClaim() else { return }
        try execute(
          "UPDATE windows SET status = 'queued', attempt_count = MAX(0, attempt_count - 1), claim_nonce = NULL, "
            + "reason_code = 'RUNTIME_INTERRUPTED', updated_at = ? "
            + "WHERE owner_user_id = ? AND meeting_id = ? AND run_id = ? AND generation = ? AND window_key = ?",
          [
            .int(nowMs()), .text(claim.ownerUserId), .text(claim.meetingId), .text(claim.runId),
            .int(Int64(claim.generation)), .text(claim.windowKey),
          ]
        )
        try finishAttempt(claim, state: "preempted", reasonCode: "RUNTIME_INTERRUPTED", at: nowMs())
        try clearRuntime(claim)
        try execute(
          "UPDATE runs SET state = 'preempted', updated_at = ?, event_sequence = event_sequence + 1 WHERE owner_user_id = ? "
            + "AND meeting_id = ? AND run_id = ? AND generation = ?",
          [.int(nowMs()), .text(claim.ownerUserId), .text(claim.meetingId), .text(claim.runId), .int(Int64(claim.generation))]
        )
      } else {
        try execute("UPDATE runs SET state = 'queued', updated_at = ?, event_sequence = event_sequence + 1 WHERE state = 'preempted'", [.int(nowMs())])
      }
    }
  }

  func releaseRuntime(runtimeOwnerToken: String, generation: Int) throws -> Bool {
    guard Self.validIdentifier(runtimeOwnerToken), generation > 0 else {
      throw MainaNativePostProcessingStoreError.invalidInput("release_identity_invalid")
    }
    return try lockedTransaction {
      guard let claim = try currentRuntimeClaim(), claim.runtimeOwnerToken == runtimeOwnerToken,
        claim.generation == generation
      else { return false }
      try execute(
        "UPDATE windows SET status = 'queued', attempt_count = MAX(0, attempt_count - 1), claim_nonce = NULL, "
          + "reason_code = 'OWNER_RELEASED', updated_at = ? "
          + "WHERE owner_user_id = ? AND meeting_id = ? AND run_id = ? AND generation = ? AND window_key = ?",
        [
          .int(nowMs()), .text(claim.ownerUserId), .text(claim.meetingId), .text(claim.runId),
          .int(Int64(claim.generation)), .text(claim.windowKey),
        ]
      )
      try finishAttempt(claim, state: "released", reasonCode: "OWNER_RELEASED", at: nowMs())
      try clearRuntime(claim)
      try execute(
        "UPDATE runs SET state = 'queued', updated_at = ?, event_sequence = event_sequence + 1 WHERE owner_user_id = ? "
          + "AND meeting_id = ? AND run_id = ? AND generation = ?",
        [.int(nowMs()), .text(claim.ownerUserId), .text(claim.meetingId), .text(claim.runId), .int(Int64(claim.generation))]
      )
      return true
    }
  }

  /** Owner is part of the SQL predicate before the hidden payload is read or parsed. */
  func readResult(ownerUserId: String, meetingId: String, runId: String, generation: Int) throws -> [String: Any]? {
    guard Self.validIdentifier(ownerUserId), Self.validIdentifier(meetingId), Self.validIdentifier(runId), generation > 0 else {
      return nil
    }
    return try locked {
      guard let row = try queryStrings(
        "SELECT result_json, result_payload_sha256 FROM runs WHERE owner_user_id = ? AND meeting_id = ? "
          + "AND run_id = ? AND generation = ? AND state IN ('complete', 'partial') AND result_json IS NOT NULL LIMIT 1",
        [.text(ownerUserId), .text(meetingId), .text(runId), .int(Int64(generation))],
        columns: 2
      ) else { return nil }
      guard var decoded = try JSONSerialization.jsonObject(with: Data(row[0].utf8)) as? [String: Any],
        let embeddedSha = decoded.removeValue(forKey: "resultPayloadSha256") as? String,
        embeddedSha == row[1], Self.sha256(canonicalData(decoded)) == embeddedSha
      else {
        throw MainaNativePostProcessingStoreError.storageFailure("terminal_result_invalid")
      }
      decoded["resultPayloadSha256"] = embeddedSha
      return decoded
    }
  }

  func readResultModelBinding(
    ownerUserId: String,
    meetingId: String,
    runId: String,
    generation: Int,
    resultId: String,
    resultPayloadSha256: String
  ) throws -> MainaNativePostProcessingModelBinding? {
    guard Self.validIdentifier(ownerUserId), Self.validIdentifier(meetingId),
      Self.validIdentifier(runId), generation > 0, Self.validIdentifier(resultId),
      Self.validSha(resultPayloadSha256)
    else { return nil }
    return try locked {
      guard let row = try queryStrings(
        "SELECT model_id, model_version, runtime_version, COALESCE(model_manifest_sha256,''), "
          + "COALESCE(CAST(model_activation_generation AS TEXT),'') FROM runs WHERE owner_user_id = ? "
          + "AND meeting_id = ? AND run_id = ? AND generation = ? AND state IN ('complete','partial') "
          + "AND result_id = ? AND result_payload_sha256 = ? AND result_json IS NOT NULL LIMIT 1",
        [
          .text(ownerUserId), .text(meetingId), .text(runId), .int(Int64(generation)),
          .text(resultId), .text(resultPayloadSha256),
        ],
        columns: 5
      ) else { return nil }
      let binding = try decodeModelBinding(
        modelId: row[0], modelVersion: row[1], runtimeVersion: row[2],
        manifestSha256: row[3], activationGeneration: row[4]
      )
      return binding
    }
  }

  func precedingTranscriptText(for claim: MainaNativePostProcessingClaim) throws -> String {
    guard claim.analysisStartMs < claim.coverageStartMs, claim.windowIndex > 0 else { return "" }
    return try locked {
      guard let blocksJSON = try queryText(
        "SELECT blocks_json FROM windows WHERE owner_user_id = ? AND meeting_id = ? AND run_id = ? "
          + "AND generation = ? AND window_index = ? AND status = 'completed' LIMIT 1",
        [
          .text(claim.ownerUserId), .text(claim.meetingId), .text(claim.runId),
          .int(Int64(claim.generation)), .int(Int64(claim.windowIndex - 1)),
        ]
      ), let data = blocksJSON.data(using: .utf8),
        let blocks = try JSONSerialization.jsonObject(with: data) as? [[String: Any]],
        let text = blocks.last?["text"] as? String
      else { return "" }
      return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
  }

  func changedEvent(ownerUserId: String, meetingId: String, runId: String, generation: Int) throws -> [String: Any]? {
    guard Self.validIdentifier(ownerUserId), Self.validIdentifier(meetingId), Self.validIdentifier(runId), generation > 0 else {
      return nil
    }
    return try locked {
      guard try persistedOwner(meetingId: meetingId) == ownerUserId,
        let value = try queryText(
          "SELECT CAST(event_sequence AS TEXT) FROM runs WHERE owner_user_id = ? AND meeting_id = ? "
            + "AND run_id = ? AND generation = ? LIMIT 1",
          [.text(ownerUserId), .text(meetingId), .text(runId), .int(Int64(generation))]
        ), let sequence = Int(value), sequence > 0
      else { return nil }
      return [
        "schemaVersion": "maina.native-post-processing-changed.v1",
        "meetingId": meetingId,
        "runId": runId,
        "generation": generation,
        "eventSequence": sequence,
      ]
    }
  }

  func acknowledge(_ fence: MainaNativePostProcessingImportFence) throws -> Bool {
    try validate(fence)
    return try lockedTransaction {
      // Owner-first lookup keeps cross-owner access indistinguishable from absence.
      guard let row = try queryStrings(
        "SELECT run_id, generation, result_id, result_payload_sha256 FROM runs WHERE owner_user_id = ? "
          + "AND meeting_id = ? AND state IN ('complete', 'partial') AND result_json IS NOT NULL LIMIT 1",
        [.text(fence.ownerUserId), .text(fence.meetingId)],
        columns: 4
      ) else { return false }
      guard row[0] == fence.runId, Int(row[1]) == fence.generation, row[2] == fence.resultId,
        row[3] == fence.resultPayloadSha256
      else { return false }
      try execute(
        "UPDATE runs SET state = 'acknowledged', result_json = NULL, result_id = NULL, result_payload_sha256 = NULL, "
          + "acknowledged_at = ?, updated_at = ?, event_sequence = event_sequence + 1 WHERE owner_user_id = ? "
          + "AND meeting_id = ? AND run_id = ? AND generation = ? AND result_id = ? AND result_payload_sha256 = ?",
        [
          .int(nowMs()), .int(nowMs()), .text(fence.ownerUserId), .text(fence.meetingId), .text(fence.runId),
          .int(Int64(fence.generation)), .text(fence.resultId), .text(fence.resultPayloadSha256),
        ]
      )
      return sqlite3_changes(database) == 1
    }
  }

  func debugState(ownerUserId: String, meetingId: String) throws -> String? {
    try locked { try queryText("SELECT state FROM runs WHERE owner_user_id = ? AND meeting_id = ?", [.text(ownerUserId), .text(meetingId)]) }
  }

  private func createSchema() throws {
    try executeBatch(
      """
      CREATE TABLE IF NOT EXISTS runs (
        owner_user_id TEXT NOT NULL,
        meeting_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK(generation > 0),
        state TEXT NOT NULL CHECK(state IN ('queued','running','preempted','partial','complete','acknowledged')),
        audio_fingerprint_sha256 TEXT NOT NULL,
        contract_version TEXT NOT NULL,
        model_id TEXT NOT NULL,
        model_version TEXT NOT NULL,
        runtime_version TEXT NOT NULL,
        model_manifest_sha256 TEXT,
        model_activation_generation INTEGER,
        runtime_owner_token TEXT NOT NULL,
        audio_duration_ms INTEGER NOT NULL CHECK(audio_duration_ms > 0),
        segment_count INTEGER NOT NULL CHECK(segment_count > 0),
        target_window_ms INTEGER NOT NULL,
        analysis_overlap_ms INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        window_plan_sha256 TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        event_sequence INTEGER NOT NULL,
        result_id TEXT,
        result_payload_sha256 TEXT,
        result_json TEXT,
        acknowledged_at INTEGER,
        PRIMARY KEY(owner_user_id, meeting_id, run_id, generation)
      );
      CREATE TABLE IF NOT EXISTS windows (
        owner_user_id TEXT NOT NULL,
        meeting_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        window_key TEXT NOT NULL,
        window_index INTEGER NOT NULL,
        audio_uri TEXT NOT NULL,
        coverage_start_ms INTEGER NOT NULL,
        coverage_end_ms INTEGER NOT NULL,
        analysis_start_ms INTEGER NOT NULL,
        analysis_end_ms INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','unresolved')),
        attempt_count INTEGER NOT NULL,
        reason_code TEXT NOT NULL,
        blocks_json TEXT,
        vad_status TEXT,
        vad_evidence_sha256 TEXT,
        claim_nonce TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(owner_user_id, meeting_id, run_id, generation, window_key),
        UNIQUE(owner_user_id, meeting_id, run_id, generation, window_index),
        FOREIGN KEY(owner_user_id, meeting_id, run_id, generation)
          REFERENCES runs(owner_user_id, meeting_id, run_id, generation) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS attempts (
        owner_user_id TEXT NOT NULL,
        meeting_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        window_key TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        runtime_owner_token TEXT NOT NULL,
        claim_nonce TEXT NOT NULL,
        state TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        PRIMARY KEY(claim_nonce)
      );
      CREATE TABLE IF NOT EXISTS runtime_owner (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        owner_user_id TEXT NOT NULL,
        meeting_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        window_key TEXT NOT NULL,
        runtime_owner_token TEXT NOT NULL,
        claim_nonce TEXT NOT NULL,
        process_instance_token TEXT NOT NULL,
        claimed_at INTEGER NOT NULL
      );
      """
    )
    try addRunModelIdentityColumns()
  }

  private func addRunModelIdentityColumns() throws {
    let columns = Set(try queryRows("PRAGMA table_info(runs)", [], columns: 6).map { $0[1] })
    if !columns.contains("model_manifest_sha256") {
      try execute("ALTER TABLE runs ADD COLUMN model_manifest_sha256 TEXT")
    }
    if !columns.contains("model_activation_generation") {
      try execute("ALTER TABLE runs ADD COLUMN model_activation_generation INTEGER")
    }
  }

  private func validModelIdentityPair(
    modelVersion: String,
    manifestSha256: String?,
    activationGeneration: UInt64?
  ) -> Bool {
    if manifestSha256 == nil || activationGeneration == nil {
      return manifestSha256 == nil && activationGeneration == nil && modelVersion == "1"
    }
    return Self.validSha(manifestSha256!) && activationGeneration! > 0
      && activationGeneration! <= UInt64(Int64.max)
  }

  private func decodeModelBinding(
    modelId: String,
    modelVersion: String,
    runtimeVersion: String,
    manifestSha256: String,
    activationGeneration: String
  ) throws -> MainaNativePostProcessingModelBinding {
    guard Self.validIdentifier(modelId), Self.validIdentifier(modelVersion),
      Self.validIdentifier(runtimeVersion)
    else { throw MainaNativePostProcessingStoreError.storageFailure("model_identity_invalid") }
    if manifestSha256.isEmpty || activationGeneration.isEmpty {
      guard manifestSha256.isEmpty, activationGeneration.isEmpty, modelVersion == "1" else {
        throw MainaNativePostProcessingStoreError.storageFailure("model_identity_invalid")
      }
      return .init(
        modelId: modelId, modelVersion: modelVersion, runtimeVersion: runtimeVersion,
        manifestSha256: nil, activationGeneration: nil
      )
    }
    guard Self.validSha(manifestSha256), let generation = UInt64(activationGeneration),
      generation > 0, generation <= UInt64(Int64.max)
    else { throw MainaNativePostProcessingStoreError.storageFailure("model_identity_invalid") }
    return .init(
      modelId: modelId, modelVersion: modelVersion, runtimeVersion: runtimeVersion,
      manifestSha256: manifestSha256, activationGeneration: generation
    )
  }

  /**
   * A persisted recognizer claim owned by another process instance cannot
   * complete after this process has opened the WAL. Reclaim it exactly once;
   * opening another Store inside the same process is observational only.
   */
  private func recoverInterruptedProcessClaims() throws {
    try lockedTransaction {
      guard let persistedProcess = try queryText(
        "SELECT process_instance_token FROM runtime_owner WHERE singleton = 1"
      ), persistedProcess != processInstanceToken else { return }
      guard let claim = try currentRuntimeClaim() else {
        throw MainaNativePostProcessingStoreError.storageFailure("runtime_owner_corrupt")
      }
      let exhausted = claim.attemptCount >= claim.maxAttempts
      let windowState = exhausted ? "failed" : "queued"
      let reason = exhausted ? "RETRY_BUDGET_EXHAUSTED" : "RUNTIME_INTERRUPTED"
      let current = nowMs()
      try execute(
        "UPDATE windows SET status = ?, claim_nonce = NULL, reason_code = ?, updated_at = ? WHERE owner_user_id = ? "
          + "AND meeting_id = ? AND run_id = ? AND generation = ? AND window_key = ? AND status = 'running'",
        [
          .text(windowState), .text(reason), .int(current), .text(claim.ownerUserId), .text(claim.meetingId),
          .text(claim.runId), .int(Int64(claim.generation)), .text(claim.windowKey),
        ]
      )
      try finishAttempt(claim, state: "interrupted", reasonCode: reason, at: current)
      try clearRuntime(claim)
      try execute(
        "UPDATE runs SET state = 'queued', updated_at = ?, event_sequence = event_sequence + 1 WHERE owner_user_id = ? "
          + "AND meeting_id = ? AND run_id = ? AND generation = ?",
        [.int(current), .text(claim.ownerUserId), .text(claim.meetingId), .text(claim.runId), .int(Int64(claim.generation))]
      )
      try sealIfTerminal(claim)
    }
  }

  private func validate(_ input: MainaNativePostProcessingStart) throws {
    try validateIdentity(input)
    guard input.contractVersion == "1.0", input.audioDurationMs > 0, input.audioDurationMs <= 86_400_000,
      input.segmentCount > 0, input.segmentCount <= 10_000, input.createdAtMs > 0,
      input.windowConfig.targetWindowMs >= 1_000, input.windowConfig.targetWindowMs <= 600_000,
      input.windowConfig.analysisOverlapMs >= 0, input.windowConfig.analysisOverlapMs <= 30_000,
      input.windowConfig.maxAttempts >= 1, input.windowConfig.maxAttempts <= 10,
      !input.windows.isEmpty, input.windows.count <= 10_000
    else { throw MainaNativePostProcessingStoreError.invalidInput("start_shape_invalid") }
    var cursor = 0
    var currentAudioURI: String?
    var currentAudioGlobalStart = 0
    var closedAudioURIs = Set<String>()
    for (expectedIndex, window) in input.windows.enumerated() {
      if currentAudioURI != window.audioURI {
        if let currentAudioURI { closedAudioURIs.insert(currentAudioURI) }
        guard !closedAudioURIs.contains(window.audioURI) else {
          throw MainaNativePostProcessingStoreError.invalidInput("window_partition_invalid")
        }
        currentAudioURI = window.audioURI
        currentAudioGlobalStart = window.coverageStartMs
      }
      guard window.index == expectedIndex, !window.audioURI.isEmpty, window.audioURI.count <= 4_096,
        URL(string: window.audioURI)?.isFileURL == true,
        window.audioStartMs >= 0, window.audioEndMs > window.audioStartMs,
        window.audioEndMs - window.audioStartMs == window.analysisEndMs - window.analysisStartMs,
        window.audioStartMs == window.analysisStartMs - currentAudioGlobalStart,
        window.audioEndMs == window.analysisEndMs - currentAudioGlobalStart,
        window.coverageStartMs == cursor, window.coverageEndMs > window.coverageStartMs,
        window.coverageEndMs - window.coverageStartMs <= input.windowConfig.targetWindowMs,
        window.analysisStartMs >= 0, window.analysisStartMs <= window.coverageStartMs,
        window.analysisEndMs >= window.coverageEndMs, window.analysisEndMs <= input.audioDurationMs,
        window.coverageStartMs - window.analysisStartMs <= input.windowConfig.analysisOverlapMs,
        window.analysisEndMs - window.coverageEndMs <= input.windowConfig.analysisOverlapMs
      else { throw MainaNativePostProcessingStoreError.invalidInput("window_partition_invalid") }
      cursor = window.coverageEndMs
    }
    guard cursor == input.audioDurationMs else {
      throw MainaNativePostProcessingStoreError.invalidInput("window_partition_invalid")
    }
  }

  private func validateIdentity(_ input: MainaNativePostProcessingStart) throws {
    guard Self.validIdentifier(input.ownerUserId), Self.validIdentifier(input.meetingId),
      Self.validIdentifier(input.runId), Self.validIdentifier(input.modelId),
      Self.validIdentifier(input.modelVersion), Self.validIdentifier(input.runtimeVersion),
      Self.validIdentifier(input.runtimeOwnerToken), Self.validSha(input.audioFingerprintSha256), input.generation > 0,
      validModelIdentityPair(
        modelVersion: input.modelVersion,
        manifestSha256: input.modelManifestSha256,
        activationGeneration: input.modelActivationGeneration
      )
    else { throw MainaNativePostProcessingStoreError.invalidInput("start_identity_invalid") }
  }

  private func validateClaim(_ claim: MainaNativePostProcessingClaim) throws {
    guard Self.validIdentifier(claim.ownerUserId), Self.validIdentifier(claim.meetingId),
      Self.validIdentifier(claim.runId), Self.validIdentifier(claim.windowKey),
      Self.validIdentifier(claim.runtimeOwnerToken), Self.validIdentifier(claim.claimNonce),
      claim.generation > 0, claim.attemptCount > 0, claim.maxAttempts > 0
    else { throw MainaNativePostProcessingStoreError.invalidInput("claim_identity_invalid") }
  }

  private func validateVad(_ vad: MainaNativePostProcessingVadInput) throws {
    guard ["speech", "silence", "unavailable"].contains(vad.status), Self.validSha(vad.evidenceSha256) else {
      throw MainaNativePostProcessingStoreError.invalidInput("vad_invalid")
    }
  }

  private func validate(blocks: [MainaNativePostProcessingBlockInput], claim: MainaNativePostProcessingClaim) throws {
    guard blocks.count <= 1_000 else { throw MainaNativePostProcessingStoreError.invalidInput("blocks_invalid") }
    for block in blocks {
      guard !block.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, block.text.count <= 8_192,
        Self.validLanguage(block.language), block.startedAtMs >= claim.analysisStartMs,
        block.endedAtMs > block.startedAtMs, block.endedAtMs <= claim.analysisEndMs
      else { throw MainaNativePostProcessingStoreError.invalidInput("blocks_invalid") }
    }
  }

  private func validate(_ fence: MainaNativePostProcessingImportFence) throws {
    guard fence.schemaVersion == "maina.native-post-processing-import-fence.v1", fence.state == "DURABLE",
      Self.validIdentifier(fence.ownerUserId), Self.validIdentifier(fence.meetingId),
      Self.validIdentifier(fence.runId), fence.generation > 0,
      fence.resultId.range(of: "^npr_[a-f0-9]{32}$", options: .regularExpression) != nil,
      Self.validSha(fence.resultPayloadSha256), Self.validSha(fence.transactionCommitSha256),
      Self.validISO8601(fence.importedAt)
    else { throw MainaNativePostProcessingStoreError.invalidInput("import_fence_invalid") }
  }

  private static func validIdentifier(_ value: String) -> Bool {
    identifierPattern.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
  }

  private static func validSha(_ value: String) -> Bool {
    shaPattern.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
  }

  private static func validLanguage(_ value: String) -> Bool {
    languagePattern.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
  }

  private static func validISO8601(_ value: String) -> Bool {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if fractional.date(from: value) != nil { return true }
    return ISO8601DateFormatter().date(from: value) != nil
  }

  private func exact(_ run: PersistedRun, matches input: MainaNativePostProcessingStart) -> Bool {
    run.ownerUserId == input.ownerUserId && run.meetingId == input.meetingId && run.runId == input.runId
      && run.generation == input.generation && run.audioFingerprintSha256 == input.audioFingerprintSha256
      && run.contractVersion == input.contractVersion && run.modelId == input.modelId
      && run.modelVersion == input.modelVersion && run.runtimeVersion == input.runtimeVersion
      && run.modelManifestSha256 == input.modelManifestSha256
      && run.modelActivationGeneration == input.modelActivationGeneration
      && run.runtimeOwnerToken == input.runtimeOwnerToken && run.audioDurationMs == input.audioDurationMs
      && run.segmentCount == input.segmentCount && run.targetWindowMs == input.windowConfig.targetWindowMs
      && run.analysisOverlapMs == input.windowConfig.analysisOverlapMs
      && run.maxAttempts == input.windowConfig.maxAttempts && run.windowPlanSha256 == windowPlanSha256(input)
  }

  private func persistedOwner(meetingId: String) throws -> String? {
    try queryText("SELECT owner_user_id FROM runs WHERE meeting_id = ? ORDER BY generation DESC LIMIT 1", [.text(meetingId)])
  }

  private func findRun(ownerUserId: String, meetingId: String) throws -> PersistedRun? {
    guard let row = try queryStrings(
      "SELECT owner_user_id, meeting_id, run_id, generation, state, audio_fingerprint_sha256, contract_version, "
        + "model_id, model_version, runtime_version, COALESCE(model_manifest_sha256,''), "
        + "COALESCE(CAST(model_activation_generation AS TEXT),''), runtime_owner_token, audio_duration_ms, segment_count, "
        + "target_window_ms, analysis_overlap_ms, max_attempts, window_plan_sha256, created_at "
        + "FROM runs WHERE owner_user_id = ? AND meeting_id = ? ORDER BY generation DESC LIMIT 1",
      [.text(ownerUserId), .text(meetingId)], columns: 20
    ) else { return nil }
    guard let generation = Int(row[3]), let audioDuration = Int(row[13]), let segments = Int(row[14]),
      let target = Int(row[15]), let overlap = Int(row[16]), let attempts = Int(row[17]), let created = Int64(row[19])
    else { throw MainaNativePostProcessingStoreError.storageFailure("run_record_invalid") }
    let binding = try decodeModelBinding(
      modelId: row[7], modelVersion: row[8], runtimeVersion: row[9],
      manifestSha256: row[10], activationGeneration: row[11]
    )
    return PersistedRun(
      ownerUserId: row[0], meetingId: row[1], runId: row[2], generation: generation, state: row[4],
      audioFingerprintSha256: row[5], contractVersion: row[6], modelId: row[7], modelVersion: row[8],
      runtimeVersion: row[9], modelManifestSha256: binding.manifestSha256,
      modelActivationGeneration: binding.activationGeneration, runtimeOwnerToken: row[12], audioDurationMs: audioDuration,
      segmentCount: segments, targetWindowMs: target, analysisOverlapMs: overlap, maxAttempts: attempts,
      windowPlanSha256: row[18], createdAtMs: created
    )
  }

  private func firstIncompleteWindowKey(_ input: MainaNativePostProcessingStart) throws -> String? {
    try queryText(
      "SELECT window_key FROM windows WHERE owner_user_id = ? AND meeting_id = ? AND run_id = ? AND generation = ? "
        + "AND status IN ('queued','running') ORDER BY window_index ASC LIMIT 1",
      [.text(input.ownerUserId), .text(input.meetingId), .text(input.runId), .int(Int64(input.generation))]
    )
  }

  private func firstWindow(_ input: MainaNativePostProcessingStart, states: [String]) throws -> PersistedWindow? {
    let placeholders = states.map { _ in "?" }.joined(separator: ",")
    let values: [Value] = [
      .text(input.ownerUserId), .text(input.meetingId), .text(input.runId), .int(Int64(input.generation)),
    ] + states.map(Value.text)
    guard let row = try queryStrings(
      "SELECT window_key, window_index, coverage_start_ms, coverage_end_ms, analysis_start_ms, analysis_end_ms, "
        + "status, attempt_count, reason_code, COALESCE(blocks_json,''), COALESCE(vad_status,''), "
        + "COALESCE(vad_evidence_sha256,'') FROM windows WHERE owner_user_id = ? AND meeting_id = ? "
        + "AND run_id = ? AND generation = ? AND status IN (\(placeholders)) ORDER BY window_index ASC LIMIT 1",
      values, columns: 12
    ) else { return nil }
    return persistedWindow(row)
  }

  private func allWindows(_ input: MainaNativePostProcessingStart) throws -> [PersistedWindow] {
    try queryRows(
      "SELECT window_key, window_index, coverage_start_ms, coverage_end_ms, analysis_start_ms, analysis_end_ms, "
        + "status, attempt_count, reason_code, COALESCE(blocks_json,''), COALESCE(vad_status,''), "
        + "COALESCE(vad_evidence_sha256,'') FROM windows WHERE owner_user_id = ? AND meeting_id = ? "
        + "AND run_id = ? AND generation = ? ORDER BY window_index ASC",
      [.text(input.ownerUserId), .text(input.meetingId), .text(input.runId), .int(Int64(input.generation))], columns: 12
    ).map(persistedWindow)
  }

  private func allWindows(_ claim: MainaNativePostProcessingClaim) throws -> [PersistedWindow] {
    try queryRows(
      "SELECT window_key, window_index, coverage_start_ms, coverage_end_ms, analysis_start_ms, analysis_end_ms, "
        + "status, attempt_count, reason_code, COALESCE(blocks_json,''), COALESCE(vad_status,''), "
        + "COALESCE(vad_evidence_sha256,'') FROM windows WHERE owner_user_id = ? AND meeting_id = ? "
        + "AND run_id = ? AND generation = ? ORDER BY window_index ASC",
      [.text(claim.ownerUserId), .text(claim.meetingId), .text(claim.runId), .int(Int64(claim.generation))], columns: 12
    ).map(persistedWindow)
  }

  private func persistedWindow(_ row: [String]) -> PersistedWindow {
    PersistedWindow(
      windowKey: row[0], index: Int(row[1]) ?? -1,
      coverageStartMs: Int(row[2]) ?? -1, coverageEndMs: Int(row[3]) ?? -1,
      analysisStartMs: Int(row[4]) ?? -1, analysisEndMs: Int(row[5]) ?? -1,
      status: row[6], attemptCount: Int(row[7]) ?? -1,
      reasonCode: row[8], blocksJSON: row[9].isEmpty ? nil : row[9],
      vadStatus: row[10].isEmpty ? nil : row[10], vadEvidenceSha256: row[11].isEmpty ? nil : row[11]
    )
  }

  private func audioURI(_ input: MainaNativePostProcessingStart, windowKey: String) throws -> String {
    guard let value = try queryText(
      "SELECT audio_uri FROM windows WHERE owner_user_id = ? AND meeting_id = ? AND run_id = ? AND generation = ? AND window_key = ?",
      [.text(input.ownerUserId), .text(input.meetingId), .text(input.runId), .int(Int64(input.generation)), .text(windowKey)]
    ) else { throw MainaNativePostProcessingStoreError.storageFailure("window_audio_missing") }
    return value
  }

  private func runtimeOwnerExists() throws -> Bool {
    try queryText("SELECT CAST(COUNT(*) AS TEXT) FROM runtime_owner") != "0"
  }

  private func currentRuntimeClaim() throws -> MainaNativePostProcessingClaim? {
    guard let row = try queryStrings(
      "SELECT r.owner_user_id, r.meeting_id, r.run_id, r.generation, r.window_key, w.window_index, w.audio_uri, "
        + "w.coverage_start_ms, w.coverage_end_ms, w.analysis_start_ms, w.analysis_end_ms, r.runtime_owner_token, "
        + "r.claim_nonce, w.attempt_count, runs.max_attempts FROM runtime_owner r JOIN windows w ON "
        + "w.owner_user_id=r.owner_user_id AND w.meeting_id=r.meeting_id AND w.run_id=r.run_id "
        + "AND w.generation=r.generation AND w.window_key=r.window_key JOIN runs ON runs.owner_user_id=r.owner_user_id "
        + "AND runs.meeting_id=r.meeting_id AND runs.run_id=r.run_id AND runs.generation=r.generation WHERE r.singleton=1",
      [], columns: 15
    ) else { return nil }
    return MainaNativePostProcessingClaim(
      ownerUserId: row[0], meetingId: row[1], runId: row[2], generation: Int(row[3]) ?? -1,
      windowKey: row[4], windowIndex: Int(row[5]) ?? -1, audioURI: row[6],
      // A recovered stale claim is only fenced/released, never decoded. The
      // exact decoder-local bounds are reconstructed on the next fresh claim.
      audioStartMs: Int(row[9]) ?? -1, audioEndMs: Int(row[10]) ?? -1,
      coverageStartMs: Int(row[7]) ?? -1, coverageEndMs: Int(row[8]) ?? -1,
      analysisStartMs: Int(row[9]) ?? -1, analysisEndMs: Int(row[10]) ?? -1,
      runtimeOwnerToken: row[11], claimNonce: row[12], attemptCount: Int(row[13]) ?? -1,
      maxAttempts: Int(row[14]) ?? -1
    )
  }

  private func ownsRuntime(_ claim: MainaNativePostProcessingClaim) throws -> Bool {
    guard let owner = try currentRuntimeClaim() else { return false }
    return owner.ownerUserId == claim.ownerUserId && owner.meetingId == claim.meetingId
      && owner.runId == claim.runId && owner.generation == claim.generation
      && owner.windowKey == claim.windowKey && owner.runtimeOwnerToken == claim.runtimeOwnerToken
      && owner.claimNonce == claim.claimNonce
  }

  private func preemptForRecordingLocked(_ input: MainaNativePostProcessingStart) throws {
    if let claim = try currentRuntimeClaim() {
      try execute(
        "UPDATE windows SET status = 'queued', attempt_count = MAX(0, attempt_count - 1), claim_nonce = NULL, "
          + "reason_code = 'RUNTIME_INTERRUPTED', updated_at = ? "
          + "WHERE owner_user_id = ? AND meeting_id = ? AND run_id = ? AND generation = ? AND window_key = ?",
        [
          .int(nowMs()), .text(claim.ownerUserId), .text(claim.meetingId), .text(claim.runId),
          .int(Int64(claim.generation)), .text(claim.windowKey),
        ]
      )
      try finishAttempt(claim, state: "preempted", reasonCode: "RUNTIME_INTERRUPTED", at: nowMs())
      try clearRuntime(claim)
      try execute(
        "UPDATE runs SET state = 'preempted', updated_at = ?, event_sequence = event_sequence + 1 WHERE owner_user_id = ? "
          + "AND meeting_id = ? AND run_id = ? AND generation = ? AND state IN ('queued','running')",
        [.int(nowMs()), .text(claim.ownerUserId), .text(claim.meetingId), .text(claim.runId), .int(Int64(claim.generation))]
      )
    }
    try execute(
      "UPDATE runs SET state = 'preempted', updated_at = ?, event_sequence = event_sequence + 1 WHERE owner_user_id = ? "
        + "AND meeting_id = ? AND run_id = ? AND generation = ? AND state IN ('queued','running')",
      [.int(nowMs()), .text(input.ownerUserId), .text(input.meetingId), .text(input.runId), .int(Int64(input.generation))]
    )
  }

  private func finishAttempt(_ claim: MainaNativePostProcessingClaim, state: String, reasonCode: String, at: Int64) throws {
    try execute(
      "UPDATE attempts SET state = ?, reason_code = ?, finished_at = ? WHERE owner_user_id = ? AND meeting_id = ? "
        + "AND run_id = ? AND generation = ? AND window_key = ? AND attempt_number = ? AND claim_nonce = ? AND state = 'running'",
      [
        .text(state), .text(reasonCode), .int(at), .text(claim.ownerUserId), .text(claim.meetingId),
        .text(claim.runId), .int(Int64(claim.generation)), .text(claim.windowKey), .int(Int64(claim.attemptCount)),
        .text(claim.claimNonce),
      ]
    )
  }

  private func clearRuntime(_ claim: MainaNativePostProcessingClaim) throws {
    try execute(
      "DELETE FROM runtime_owner WHERE singleton = 1 AND owner_user_id = ? AND meeting_id = ? AND run_id = ? "
        + "AND generation = ? AND window_key = ? AND runtime_owner_token = ? AND claim_nonce = ?",
      [
        .text(claim.ownerUserId), .text(claim.meetingId), .text(claim.runId), .int(Int64(claim.generation)),
        .text(claim.windowKey), .text(claim.runtimeOwnerToken), .text(claim.claimNonce),
      ]
    )
  }

  private func sealIfTerminal(_ input: MainaNativePostProcessingStart) throws {
    guard let run = try findRun(ownerUserId: input.ownerUserId, meetingId: input.meetingId) else { return }
    try seal(input: canonicalStart(run), windows: allWindows(input))
  }

  private func sealIfTerminal(_ claim: MainaNativePostProcessingClaim) throws {
    guard let run = try findRun(ownerUserId: claim.ownerUserId, meetingId: claim.meetingId) else { return }
    try seal(input: canonicalStart(run), windows: allWindows(claim))
  }

  private func canonicalStart(_ run: PersistedRun) -> MainaNativePostProcessingStart {
    MainaNativePostProcessingStart(
      ownerUserId: run.ownerUserId, meetingId: run.meetingId, runId: run.runId, generation: run.generation,
      audioFingerprintSha256: run.audioFingerprintSha256, contractVersion: run.contractVersion,
      modelId: run.modelId, modelVersion: run.modelVersion, runtimeVersion: run.runtimeVersion,
      modelManifestSha256: run.modelManifestSha256,
      modelActivationGeneration: run.modelActivationGeneration,
      runtimeOwnerToken: run.runtimeOwnerToken, audioDurationMs: run.audioDurationMs, segmentCount: run.segmentCount,
      windowConfig: .init(targetWindowMs: run.targetWindowMs, analysisOverlapMs: run.analysisOverlapMs, maxAttempts: run.maxAttempts),
      windows: [], createdAtMs: run.createdAtMs
    )
  }

  private func seal(input: MainaNativePostProcessingStart, windows: [PersistedWindow]) throws {
    guard !windows.isEmpty, windows.allSatisfy({ ["completed", "failed", "unresolved"].contains($0.status) }) else { return }
    let failed = windows.filter { $0.status == "failed" }
    let unresolved = windows.filter { $0.status == "unresolved" }
    let disposition = failed.isEmpty && unresolved.isEmpty ? "complete" : "partial"
    let resultId = "npr_" + String(Self.sha256(canonicalData([
      "ownerUserId": input.ownerUserId, "meetingId": input.meetingId, "runId": input.runId,
      "generation": input.generation, "audioFingerprintSha256": input.audioFingerprintSha256,
      "contractVersion": input.contractVersion, "modelId": input.modelId,
      "modelVersion": input.modelVersion, "runtimeVersion": input.runtimeVersion,
      "createdAt": Self.isoDate(input.createdAtMs),
      "windowConfig": [
        "targetWindowMs": input.windowConfig.targetWindowMs,
        "analysisOverlapMs": input.windowConfig.analysisOverlapMs,
        "maxAttempts": input.windowConfig.maxAttempts,
      ],
    ])).prefix(32))
    var sequence = 0
    let windowPayloads: [[String: Any]] = try windows.map { window in
      let blocks: [[String: Any]]
      if let blocksJSON = window.blocksJSON,
        let decoded = try JSONSerialization.jsonObject(with: Data(blocksJSON.utf8)) as? [[String: Any]] {
        blocks = decoded.map { block in
          var copy = block
          copy["sequence"] = sequence
          sequence += 1
          return copy
        }
      } else {
        blocks = []
      }
      return [
        "windowKey": window.windowKey,
        "index": window.index,
        "coverageStartMs": window.coverageStartMs,
        "coverageEndMs": window.coverageEndMs,
        "analysisStartMs": window.analysisStartMs,
        "analysisEndMs": window.analysisEndMs,
        "status": window.status,
        "blocks": blocks,
        "retry": [
          "attemptCount": window.attemptCount,
          "maxAttempts": input.windowConfig.maxAttempts,
          "lastReasonCode": window.reasonCode,
        ],
        "vad": [
          "status": window.vadStatus ?? "unavailable",
          "evidenceSha256": window.vadEvidenceSha256 ?? String(repeating: "0", count: 64),
        ],
      ]
    }
    let unresolvedPayloads: [[String: Any]] = windows.compactMap { window in
      guard window.status == "failed" || window.status == "unresolved" else { return nil }
      return [
        "windowKey": window.windowKey,
        "startMs": window.coverageStartMs,
        "endMs": window.coverageEndMs,
        "outcome": window.status,
        "reasonCode": window.reasonCode,
      ]
    }
    var payload: [String: Any] = [
      "schemaVersion": "maina.native-post-processing-result.v1",
      "identity": [
        "ownerUserId": input.ownerUserId,
        "meetingId": input.meetingId,
        "runId": input.runId,
        "generation": input.generation,
        "resultId": resultId,
        "audioFingerprintSha256": input.audioFingerprintSha256,
        "contractVersion": input.contractVersion,
        "modelId": input.modelId,
        "modelVersion": input.modelVersion,
        "runtimeVersion": input.runtimeVersion,
        "createdAt": Self.isoDate(input.createdAtMs),
      ],
      "disposition": disposition,
      "audio": ["durationMs": input.audioDurationMs, "segmentCount": input.segmentCount],
      "windowConfig": [
        "targetWindowMs": input.windowConfig.targetWindowMs,
        "analysisOverlapMs": input.windowConfig.analysisOverlapMs,
        "maxAttempts": input.windowConfig.maxAttempts,
      ],
      "windows": windowPayloads,
      "unresolvedIntervals": unresolvedPayloads,
      "coverage": [
        "windowCount": windows.count,
        "completedWindows": windows.filter { $0.status == "completed" }.count,
        "failedWindows": failed.count,
        "unresolvedWindows": unresolved.count,
        "coverageComplete": disposition == "complete",
      ],
    ]
    let payloadSha = Self.sha256(canonicalData(payload))
    payload["resultPayloadSha256"] = payloadSha
    let payloadData = canonicalData(payload)
    guard let payloadJSON = String(data: payloadData, encoding: .utf8) else {
      throw MainaNativePostProcessingStoreError.storageFailure("terminal_result_encode_failed")
    }
    try execute(
      "UPDATE runs SET state = ?, result_id = ?, result_payload_sha256 = ?, result_json = ?, updated_at = ?, "
        + "event_sequence = event_sequence + 1 WHERE owner_user_id = ? AND meeting_id = ? AND run_id = ? AND generation = ?",
      [
        .text(disposition), .text(resultId), .text(payloadSha), .text(payloadJSON), .int(nowMs()),
        .text(input.ownerUserId), .text(input.meetingId), .text(input.runId), .int(Int64(input.generation)),
      ]
    )
  }

  private func makeBlocksJSON(
    _ blocks: [MainaNativePostProcessingBlockInput],
    claim: MainaNativePostProcessingClaim
  ) throws -> String {
    let payload: [[String: Any]] = blocks.enumerated().map { index, block in
      [
        "blockKey": "npb_" + String(Self.sha256(Data("\(claim.windowKey):\(index)".utf8)).prefix(24)),
        "sequence": index,
        "startedAtMs": block.startedAtMs,
        "endedAtMs": block.endedAtMs,
        "text": block.text.trimmingCharacters(in: .whitespacesAndNewlines),
        "language": block.language,
      ]
    }
    guard let value = String(data: canonicalData(payload), encoding: .utf8) else {
      throw MainaNativePostProcessingStoreError.storageFailure("block_encode_failed")
    }
    return value
  }

  private func windowKey(input: MainaNativePostProcessingStart, window: MainaNativePostProcessingWindowPlan) -> String {
    let material = "\(input.ownerUserId)|\(input.meetingId)|\(input.runId)|\(input.generation)|\(window.index)|\(window.coverageStartMs)|\(window.coverageEndMs)"
    return "npw_" + String(Self.sha256(Data(material.utf8)).prefix(24))
  }

  private func windowPlanSha256(_ input: MainaNativePostProcessingStart) -> String {
    Self.sha256(canonicalData(input.windows.map { window in
      [
        "index": window.index,
        "audioURI": window.audioURI,
        "coverageStartMs": window.coverageStartMs,
        "coverageEndMs": window.coverageEndMs,
        "analysisStartMs": window.analysisStartMs,
        "analysisEndMs": window.analysisEndMs,
      ]
    }))
  }

  private func canonicalData(_ value: Any) -> Data {
    (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data()
  }

  private static func sha256(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  private static func isoDate(_ milliseconds: Int64) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: Date(timeIntervalSince1970: Double(milliseconds) / 1_000))
  }

  private func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1_000) }

  private func locked<T>(_ task: () throws -> T) rethrows -> T {
    lock.lock()
    defer { lock.unlock() }
    return try task()
  }

  private func lockedTransaction<T>(_ task: () throws -> T) throws -> T {
    try locked {
      try execute("BEGIN IMMEDIATE")
      do {
        let result = try task()
        try execute("COMMIT")
        return result
      } catch {
        try? execute("ROLLBACK")
        throw error
      }
    }
  }

  private func execute(_ sql: String, _ values: [Value] = []) throws {
    guard let database else { throw MainaNativePostProcessingStoreError.storageFailure("database_closed") }
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
      throw MainaNativePostProcessingStoreError.storageFailure("statement_prepare_failed")
    }
    defer { sqlite3_finalize(statement) }
    try bind(values, to: statement)
    let code = sqlite3_step(statement)
    guard code == SQLITE_DONE || code == SQLITE_ROW else {
      throw MainaNativePostProcessingStoreError.storageFailure("statement_execute_failed")
    }
  }

  private func executeBatch(_ sql: String) throws {
    guard let database else { throw MainaNativePostProcessingStoreError.storageFailure("database_closed") }
    guard sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK else {
      throw MainaNativePostProcessingStoreError.storageFailure("schema_execute_failed")
    }
  }

  private func queryText(_ sql: String, _ values: [Value] = []) throws -> String? {
    try queryStrings(sql, values, columns: 1)?[0]
  }

  private func queryStrings(_ sql: String, _ values: [Value], columns: Int) throws -> [String]? {
    try queryRows(sql, values, columns: columns).first
  }

  private func queryRows(_ sql: String, _ values: [Value], columns: Int) throws -> [[String]] {
    guard let database else { throw MainaNativePostProcessingStoreError.storageFailure("database_closed") }
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
      throw MainaNativePostProcessingStoreError.storageFailure("query_prepare_failed")
    }
    defer { sqlite3_finalize(statement) }
    try bind(values, to: statement)
    var rows: [[String]] = []
    while true {
      let code = sqlite3_step(statement)
      if code == SQLITE_DONE { break }
      guard code == SQLITE_ROW else {
        throw MainaNativePostProcessingStoreError.storageFailure("query_execute_failed")
      }
      rows.append((0..<columns).map { column in
        guard let pointer = sqlite3_column_text(statement, Int32(column)) else { return "" }
        return String(cString: pointer)
      })
    }
    return rows
  }

  private func bind(_ values: [Value], to statement: OpaquePointer) throws {
    for (offset, value) in values.enumerated() {
      let index = Int32(offset + 1)
      let result: Int32
      switch value {
      case .text(let text):
        result = sqlite3_bind_text(statement, index, text, -1, Self.sqliteTransient)
      case .int(let integer):
        result = sqlite3_bind_int64(statement, index, integer)
      case .null:
        result = sqlite3_bind_null(statement, index)
      }
      guard result == SQLITE_OK else {
        throw MainaNativePostProcessingStoreError.storageFailure("value_bind_failed")
      }
    }
  }
}
