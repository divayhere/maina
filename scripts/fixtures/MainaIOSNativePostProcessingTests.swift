import Foundation
import SQLite3

private var assertions = 0

private final class FakeNativePostProcessingTranscriber {
  typealias Completion = (Result<MainaNativePostProcessingRecognition, MainaNativePostProcessingRecognitionFailure>) -> Void
  private let lock = NSLock()
  private var pending: [(MainaNativePostProcessingClaim, Completion)] = []
  private(set) var maximumPending = 0

  func transcribe(_ claim: MainaNativePostProcessingClaim, completion: @escaping Completion) {
    lock.lock()
    pending.append((claim, completion))
    maximumPending = max(maximumPending, pending.count)
    lock.unlock()
  }

  var pendingCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return pending.count
  }

  func completeNext(
    _ result: Result<MainaNativePostProcessingRecognition, MainaNativePostProcessingRecognitionFailure>
  ) {
    lock.lock()
    let next = pending.removeFirst()
    lock.unlock()
    next.1(result)
  }
}

private final class NativePostProcessingEvents {
  private let lock = NSLock()
  private var values: [[String: Any]] = []

  func append(_ event: [String: Any]) {
    lock.lock()
    values.append(event)
    lock.unlock()
  }

  var last: [String: Any]? {
    lock.lock()
    defer { lock.unlock() }
    return values.last
  }
}

private func waitUntil(_ message: String, timeout: TimeInterval = 2, _ condition: () -> Bool) {
  let deadline = Date().addingTimeInterval(timeout)
  while Date() < deadline {
    if condition() { return }
    Thread.sleep(forTimeInterval: 0.01)
  }
  expect(condition(), message)
}

private func expect(_ condition: Bool, _ message: String) {
  assertions += 1
  if !condition {
    FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
    exit(1)
  }
}

private func expectThrows(
  _ expected: MainaNativePostProcessingStoreError,
  _ message: String,
  _ operation: () throws -> Void
) {
  assertions += 1
  do {
    try operation()
    FileHandle.standardError.write(Data("FAIL: \(message) did not throw\n".utf8))
    exit(1)
  } catch let error as MainaNativePostProcessingStoreError {
    if error != expected {
      FileHandle.standardError.write(Data("FAIL: \(message) threw \(error)\n".utf8))
      exit(1)
    }
  } catch {
    FileHandle.standardError.write(Data("FAIL: \(message) threw unexpected \(error)\n".utf8))
    exit(1)
  }
}

private func expectBridgeThrows(_ message: String, _ operation: () throws -> Void) {
  assertions += 1
  do {
    try operation()
    FileHandle.standardError.write(Data("FAIL: \(message) did not throw\n".utf8))
    exit(1)
  } catch is MainaNativePostProcessingBridgeError {
    return
  } catch {
    FileHandle.standardError.write(Data("FAIL: \(message) threw unexpected \(error)\n".utf8))
    exit(1)
  }
}

private func executeSQLite(_ databaseURL: URL, _ sql: String) throws {
  var database: OpaquePointer?
  guard sqlite3_open_v2(databaseURL.path, &database, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK,
    let database
  else { throw MainaNativePostProcessingStoreError.storageFailure("test_database_open_failed") }
  defer { sqlite3_close(database) }
  guard sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK else {
    throw MainaNativePostProcessingStoreError.storageFailure("test_database_mutation_failed")
  }
}

private func makeStart(
  owner: String = "owner-a",
  meeting: String = "meeting-a",
  run: String = "run-a",
  generation: Int = 1,
  token: String = "runtime-a",
  maxAttempts: Int = 2,
  fingerprint: String = String(repeating: "a", count: 64),
  firstAudioURI: String = "file:///synthetic/capture-00000.wav",
  createdAtMs: Int64 = 1_788_000_000_000
) -> MainaNativePostProcessingStart {
  MainaNativePostProcessingStart(
    ownerUserId: owner,
    meetingId: meeting,
    runId: run,
    generation: generation,
    audioFingerprintSha256: fingerprint,
    contractVersion: "1.0",
    modelId: "qwen3-0.6b-int8",
    modelVersion: "model-v1",
    runtimeVersion: "sherpa-1.13.4-ios",
    runtimeOwnerToken: token,
    audioDurationMs: 20_000,
    segmentCount: 1,
    windowConfig: .init(targetWindowMs: 10_000, analysisOverlapMs: 1_000, maxAttempts: maxAttempts),
    windows: [
      .init(
        index: 0,
        audioURI: firstAudioURI,
        audioStartMs: 0,
        audioEndMs: 11_000,
        coverageStartMs: 0,
        coverageEndMs: 10_000,
        analysisStartMs: 0,
        analysisEndMs: 11_000
      ),
      .init(
        index: 1,
        audioURI: firstAudioURI,
        audioStartMs: 9_000,
        audioEndMs: 20_000,
        coverageStartMs: 10_000,
        coverageEndMs: 20_000,
        analysisStartMs: 9_000,
        analysisEndMs: 20_000
      ),
    ],
    createdAtMs: createdAtMs
  )
}

private func complete(
  _ store: MainaNativePostProcessingStore,
  _ claim: MainaNativePostProcessingClaim,
  text: String
) throws {
  let blocks = text.isEmpty ? [] : [MainaNativePostProcessingBlockInput(
    startedAtMs: claim.coverageStartMs,
    endedAtMs: claim.coverageEndMs,
    text: text,
    language: "en"
  )]
  let committed = try store.commitWindow(
    claim: claim,
    blocks: blocks,
    vad: .init(
      status: text.isEmpty ? "silence" : "speech",
      evidenceSha256: String(repeating: text.isEmpty ? "b" : "c", count: 64)
    )
  )
  expect(committed, "exact live claim commits")
}

private func resultIdentity(_ result: [String: Any]) -> [String: Any] {
  result["identity"] as? [String: Any] ?? [:]
}

private func run() throws {
  let exactStartDictionary: [String: Any] = [
    "ownerUserId": "owner-a",
    "meetingId": "meeting-a",
    "runId": "run-a",
    "generation": 1,
    "audioFingerprintSha256": String(repeating: "a", count: 64),
    "windowConfig": ["targetWindowMs": 10_000, "analysisOverlapMs": 1_000, "maxAttempts": 2],
    "runtimeOwnerToken": "runtime-a",
  ]
  let decodedStart = try MainaNativePostProcessingBridgeCodec.start(exactStartDictionary)
  expect(decodedStart.meetingId == "meeting-a", "closed Expo start request decodes")
  var bridgedStart = exactStartDictionary
  bridgedStart["generation"] = 1.0
  bridgedStart["windowConfig"] = ["targetWindowMs": 10_000.0, "analysisOverlapMs": 1_000.0, "maxAttempts": 2.0]
  expect(try MainaNativePostProcessingBridgeCodec.start(bridgedStart) == decodedStart,
    "integral JavaScript doubles decode without rounding drift")
  var fractionalStart = bridgedStart
  fractionalStart["generation"] = 1.5
  expectBridgeThrows("fractional JavaScript generation fails closed") {
    _ = try MainaNativePostProcessingBridgeCodec.start(fractionalStart)
  }
  var extraStart = exactStartDictionary
  extraStart["directory"] = "file:///private"
  expectBridgeThrows("start request rejects undeclared transport fields") {
    _ = try MainaNativePostProcessingBridgeCodec.start(extraStart)
  }
  var invalidWindowStart = exactStartDictionary
  invalidWindowStart["windowConfig"] = ["targetWindowMs": 10_000, "analysisOverlapMs": 10_000, "maxAttempts": 2]
  expectBridgeThrows("analysis overlap must be shorter than coverage window") {
    _ = try MainaNativePostProcessingBridgeCodec.start(invalidWindowStart)
  }
  let read = try MainaNativePostProcessingBridgeCodec.read([
    "ownerUserId": "owner-a", "meetingId": "meeting-a", "runId": "run-a", "generation": 1,
  ])
  expect(read.ownerUserId == "owner-a", "closed read request decodes")
  expectBridgeThrows("read request rejects unknown fields") {
    _ = try MainaNativePostProcessingBridgeCodec.read([
      "ownerUserId": "owner-a", "meetingId": "meeting-a", "runId": "run-a", "generation": 1,
      "result": "private",
    ])
  }
  let release = try MainaNativePostProcessingBridgeCodec.release([
    "runtimeOwnerToken": "runtime-a", "generation": 1,
  ])
  expect(release.generation == 1, "closed runtime-release request decodes")
  let decodedFence = try MainaNativePostProcessingBridgeCodec.acknowledge([
    "schemaVersion": "maina.native-post-processing-import-fence.v1",
    "state": "DURABLE",
    "ownerUserId": "owner-a",
    "meetingId": "meeting-a",
    "runId": "run-a",
    "generation": 1,
    "resultId": "result-a",
    "resultPayloadSha256": String(repeating: "b", count: 64),
    "importedAt": "2026-09-09T00:00:00.000Z",
    "transactionCommitSha256": String(repeating: "c", count: 64),
  ])
  expect(decodedFence.state == "DURABLE", "closed durable import fence decodes")
  expect(
    MainaNativePostProcessingTranscriptStitcher.removeExactOverlap(
      previous: "Send the final notes to Rahul",
      current: "notes to Rahul before lunch"
    ) == "before lunch",
    "native overlap stitching removes only the exact normalized boundary"
  )
  expect(
    MainaNativePostProcessingTranscriptStitcher.removeExactOverlap(
      previous: "send it to Rahul",
      current: "Rahul will review it"
    ) == "Rahul will review it",
    "native overlap stitching never drops a one-word coincidence"
  )

  let sourceSegments = [
    MainaNativePostProcessingAudioSegment(
      audioURI: "file:///synthetic/capture-00000.wav", byteCount: 1_000,
      durationMs: 12_000, sha256: String(repeating: "1", count: 64)
    ),
    MainaNativePostProcessingAudioSegment(
      audioURI: "file:///synthetic/capture-00001.wav", byteCount: 2_000,
      durationMs: 8_000, sha256: String(repeating: "2", count: 64)
    ),
  ]
  let sourceFingerprint = try MainaNativePostProcessingAudioPlanner.fingerprint(sourceSegments)
  var plannedRequestDictionary = exactStartDictionary
  plannedRequestDictionary["audioFingerprintSha256"] = sourceFingerprint
  let planned = try MainaNativePostProcessingAudioPlanner.makeStart(
    request: MainaNativePostProcessingBridgeCodec.start(plannedRequestDictionary),
    segments: sourceSegments,
    modelVersion: "1",
    runtimeVersion: "sherpa-onnx-1.13.4-ios-no-tts",
    createdAtMs: 1_788_000_000_000
  )
  expect(planned.audioDurationMs == 20_000 && planned.windows.count == 3,
    "multi-segment planner covers every finalized WAV")
  expect(planned.windows[2].coverageStartMs == 12_000 && planned.windows[2].audioStartMs == 0,
    "second WAV keeps global coverage and resets its decoder-local offset")
  expectBridgeThrows("planner rejects a caller fingerprint that differs from immutable audio") {
    _ = try MainaNativePostProcessingAudioPlanner.makeStart(
      request: decodedStart,
      segments: sourceSegments,
      modelVersion: "1",
      runtimeVersion: "sherpa-onnx-1.13.4-ios-no-tts",
      createdAtMs: 1_788_000_000_000
    )
  }

  let root = FileManager.default.temporaryDirectory
    .appendingPathComponent("maina-native-post-processing-\(UUID().uuidString)", isDirectory: true)
  defer { try? FileManager.default.removeItem(at: root) }
  let databaseURL = root.appendingPathComponent("store.sqlite3")

  let store = try MainaNativePostProcessingStore(databaseURL: databaseURL)
  let storeMode = (try FileManager.default.attributesOfItem(atPath: databaseURL.path)[.posixPermissions] as? NSNumber)?.intValue ?? -1
  let parentMode = (try FileManager.default.attributesOfItem(atPath: root.path)[.posixPermissions] as? NSNumber)?.intValue ?? -1
  expect(storeMode & 0o777 == 0o600, "durable store is mode 0600")
  expect(parentMode & 0o777 == 0o700, "durable store parent is mode 0700")
  let start = makeStart()
  let initial = try store.begin(start)
  expect(!initial.resumed, "first start is new")
  expect(initial.state == "queued", "first start is queued")
  expect(initial.firstIncompleteWindowKey != nil, "first start exposes first incomplete window")

  expectThrows(.identityConflict, "another owner cannot alias the meeting") {
    _ = try store.begin(makeStart(owner: "owner-b"))
  }
  expectThrows(.identityConflict, "immutable audio fingerprint cannot drift") {
    _ = try store.begin(makeStart(fingerprint: String(repeating: "d", count: 64)))
  }
  expectThrows(.identityConflict, "frozen window plan cannot drift") {
    _ = try store.begin(makeStart(firstAudioURI: "file:///synthetic/substituted.wav"))
  }

  let secondStart = makeStart(meeting: "meeting-b", run: "run-b", token: "runtime-b")
  _ = try store.begin(secondStart)
  let first = try store.claimFirstIncomplete(start, recordingActive: false)!
  expect(first.windowIndex == 0, "first incomplete checkpoint is claimed")
  let sameProcessReplay = try store.begin(start)
  expect(sameProcessReplay.resumed && sameProcessReplay.state == "running", "same-process start replay preserves the live claim")
  let laterReplay = try store.begin(makeStart(createdAtMs: 1_788_000_999_999))
  expect(laterReplay.resumed, "replay uses the WAL-frozen creation time rather than a new caller clock")
  expect(try store.claimFirstIncomplete(secondStart, recordingActive: false) == nil,
    "one runtime owner prevents a second recognizer claim")

  // Recording owns priority. The in-flight callback becomes stale and cannot
  // mutate the durable checkpoint after preemption.
  expect(try store.claimFirstIncomplete(secondStart, recordingActive: true) == nil,
    "recording preempts a recognizer owned by another queued meeting")
  expect(try store.debugState(ownerUserId: "owner-a", meetingId: "meeting-a") == "preempted", "recording preempts transcription")
  expect(try store.debugState(ownerUserId: "owner-a", meetingId: "meeting-b") == "preempted", "recording also blocks the requested queued run")
  expect(try store.commitWindow(
    claim: first,
    blocks: [],
    vad: .init(status: "silence", evidenceSha256: String(repeating: "b", count: 64))
  ) == false, "stale callback is rejected after recording preemption")
  try store.setRecordingActive(false)
  expect(try store.debugState(ownerUserId: "owner-a", meetingId: "meeting-a") == "queued", "durable wake requeues after recording")

  let replayedFirst = try store.claimFirstIncomplete(start, recordingActive: false)!
  expect(replayedFirst.windowIndex == 0, "preempted window is reclaimed first")
  expectThrows(.invalidInput("blocks_invalid"), "result language must match the closed P2 schema") {
    _ = try store.commitWindow(
      claim: replayedFirst,
      blocks: [.init(startedAtMs: 0, endedAtMs: 1_000, text: "invalid language", language: "1")],
      vad: .init(status: "speech", evidenceSha256: String(repeating: "c", count: 64))
    )
  }
  try complete(store, replayedFirst, text: "first window")

  let second = try store.claimFirstIncomplete(start, recordingActive: false)!
  expect(second.windowIndex == 1, "second checkpoint follows the committed first")
  expect(try store.failWindow(claim: second, reasonCode: "RUNTIME_INTERRUPTED"), "retryable failure is durable")
  expect(try store.readResult(ownerUserId: "owner-a", meetingId: "meeting-a", runId: "run-a", generation: 1) == nil, "retryable failure is not terminal")
  let secondRetry = try store.claimFirstIncomplete(start, recordingActive: false)!
  expect(secondRetry.windowKey == second.windowKey && secondRetry.attemptCount == 2, "same stable window consumes bounded retry")
  expect(try store.failWindow(claim: secondRetry, reasonCode: "AUDIO_UNREADABLE"), "final failed attempt commits")

  expect(try store.readResult(ownerUserId: "owner-b", meetingId: "meeting-a", runId: "run-a", generation: 1) == nil, "cross-owner read is non-disclosing")
  expect(try store.readResult(ownerUserId: "owner-a", meetingId: "meeting-a", runId: "other-run", generation: 1) == nil, "wrong run read is non-disclosing")
  expect(try store.readResult(ownerUserId: "owner-a", meetingId: "meeting-a", runId: "run-a", generation: 2) == nil, "stale generation read is non-disclosing")
  let partial = try store.readResult(ownerUserId: "owner-a", meetingId: "meeting-a", runId: "run-a", generation: 1)!
  expect(partial["disposition"] as? String == "partial", "failed coverage is partial")
  let coverage = partial["coverage"] as? [String: Any]
  expect(coverage?["coverageComplete"] as? Bool == false, "partial result never claims complete coverage")
  expect(coverage?["failedWindows"] as? Int == 1, "failed window is counted exactly")
  let intervals = partial["unresolvedIntervals"] as? [[String: Any]]
  expect(intervals?.count == 1, "failed interval remains explicit")
  expect(intervals?.first?["startMs"] as? Int == 10_000, "failed interval keeps exact start")
  expect(intervals?.first?["endMs"] as? Int == 20_000, "failed interval keeps exact end")

  let identity = resultIdentity(partial)
  let frozenCreatedAt = ISO8601DateFormatter()
  frozenCreatedAt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  expect(identity["createdAt"] as? String == frozenCreatedAt.string(
    from: Date(timeIntervalSince1970: Double(start.createdAtMs) / 1_000)
  ), "terminal result retains the first WAL creation time after replay")
  let resultId = identity["resultId"] as! String
  let resultSha = partial["resultPayloadSha256"] as! String
  let fence = MainaNativePostProcessingImportFence(
    schemaVersion: "maina.native-post-processing-import-fence.v1",
    state: "DURABLE",
    ownerUserId: "owner-a",
    meetingId: "meeting-a",
    runId: "run-a",
    generation: 1,
    resultId: resultId,
    resultPayloadSha256: resultSha,
    importedAt: "2026-09-09T00:00:00.000Z",
    transactionCommitSha256: String(repeating: "e", count: 64)
  )
  expect(try store.acknowledge(.init(
    schemaVersion: fence.schemaVersion,
    state: fence.state,
    ownerUserId: "owner-b",
    meetingId: fence.meetingId,
    runId: fence.runId,
    generation: fence.generation,
    resultId: fence.resultId,
    resultPayloadSha256: fence.resultPayloadSha256,
    importedAt: fence.importedAt,
    transactionCommitSha256: fence.transactionCommitSha256
  )) == false, "cross-owner acknowledgement is a no-op")
  expect(try store.acknowledge(.init(
    schemaVersion: fence.schemaVersion,
    state: fence.state,
    ownerUserId: fence.ownerUserId,
    meetingId: fence.meetingId,
    runId: fence.runId,
    generation: 2,
    resultId: fence.resultId,
    resultPayloadSha256: fence.resultPayloadSha256,
    importedAt: fence.importedAt,
    transactionCommitSha256: fence.transactionCommitSha256
  )) == false, "stale generation cannot acknowledge")
  expect(try store.acknowledge(fence), "exact durable import fence acknowledges")
  expect(try store.readResult(ownerUserId: "owner-a", meetingId: "meeting-a", runId: "run-a", generation: 1) == nil, "acknowledgement removes only terminal payload")
  expect(try store.acknowledge(fence) == false, "acknowledgement replay is idempotent")

  let restartURL = root.appendingPathComponent("restart.sqlite3")
  let restartA = try MainaNativePostProcessingStore(databaseURL: restartURL, processInstanceToken: "process-a")
  let restartStart = makeStart(meeting: "meeting-restart", run: "run-restart", token: "runtime-restart")
  _ = try restartA.begin(restartStart)
  let restartClaim = try restartA.claimFirstIncomplete(restartStart, recordingActive: false)!
  let sameProcessObserver = try MainaNativePostProcessingStore(databaseURL: restartURL, processInstanceToken: "process-a")
  expect(try sameProcessObserver.begin(restartStart).state == "running", "same process store reopen does not revoke live ownership")
  expect(try restartA.commitWindow(
    claim: restartClaim,
    blocks: [.init(startedAtMs: 0, endedAtMs: 1_000, text: "still owned", language: "en")],
    vad: .init(status: "speech", evidenceSha256: String(repeating: "c", count: 64))
  ), "same process callback remains authoritative")

  let interruptedStart = makeStart(meeting: "meeting-interrupted", run: "run-interrupted", token: "runtime-interrupted")
  _ = try restartA.begin(interruptedStart)
  _ = try restartA.claimFirstIncomplete(interruptedStart, recordingActive: false)
  let restartB = try MainaNativePostProcessingStore(databaseURL: restartURL, processInstanceToken: "process-b")
  let interruptedReplay = try restartB.begin(interruptedStart)
  expect(interruptedReplay.resumed && interruptedReplay.state == "queued", "new process recovers interrupted claim")
  let reclaimed = try restartB.claimFirstIncomplete(interruptedStart, recordingActive: false)!
  expect(reclaimed.windowIndex == 0 && reclaimed.attemptCount == 2, "restart resumes first incomplete within durable budget")

  let exhaustedStart = makeStart(
    meeting: "meeting-exhausted", run: "run-exhausted", token: "runtime-exhausted", maxAttempts: 1
  )
  expect(try restartB.releaseRuntime(runtimeOwnerToken: "runtime-interrupted", generation: 1), "test releases the reclaimed runtime only")
  _ = try restartB.begin(exhaustedStart)
  _ = try restartB.claimFirstIncomplete(exhaustedStart, recordingActive: false)
  let restartC = try MainaNativePostProcessingStore(databaseURL: restartURL, processInstanceToken: "process-c")
  let remainingAfterExhaustion = try restartC.claimFirstIncomplete(exhaustedStart, recordingActive: false)!
  expect(remainingAfterExhaustion.windowIndex == 1, "restart exhaustion advances to the next incomplete window")
  try complete(restartC, remainingAfterExhaustion, text: "remaining window")
  let exhausted = try restartC.readResult(
    ownerUserId: "owner-a", meetingId: "meeting-exhausted", runId: "run-exhausted", generation: 1
  )
  expect(exhausted?["disposition"] as? String == "partial", "restart exhaustion seals truthful partial result")

  // A new store instance proves process-restart recovery from the WAL.
  let completeStart = makeStart(meeting: "meeting-complete", run: "run-complete", token: "runtime-complete")
  _ = try store.begin(completeStart)
  let completeFirst = try store.claimFirstIncomplete(completeStart, recordingActive: false)!
  try complete(store, completeFirst, text: "alpha")
  let reopened = try MainaNativePostProcessingStore(databaseURL: databaseURL)
  let resumed = try reopened.begin(completeStart)
  expect(resumed.resumed && resumed.firstIncompleteWindowKey != nil, "restart resumes exact first incomplete checkpoint")
  let completeSecond = try reopened.claimFirstIncomplete(completeStart, recordingActive: false)!
  try complete(reopened, completeSecond, text: "beta")
  let completeResult = try reopened.readResult(ownerUserId: "owner-a", meetingId: "meeting-complete", runId: "run-complete", generation: 1)!
  expect(completeResult["disposition"] as? String == "complete", "complete partition seals complete")
  let completeCoverage = completeResult["coverage"] as? [String: Any]
  expect(completeCoverage?["coverageComplete"] as? Bool == true, "complete coverage is explicit")
  expect((completeResult["unresolvedIntervals"] as? [[String: Any]])?.isEmpty == true, "complete result has no unresolved intervals")
  if let output = ProcessInfo.processInfo.environment["MAINA_NATIVE_POST_PROCESSING_RESULT_OUTPUT"] {
    let data = try JSONSerialization.data(withJSONObject: completeResult, options: [.sortedKeys])
    try data.write(to: URL(fileURLWithPath: output), options: .atomic)
  }

  let integrityURL = root.appendingPathComponent("integrity.sqlite3")
  let integrityStore = try MainaNativePostProcessingStore(databaseURL: integrityURL)
  let integrityStart = makeStart(meeting: "meeting-integrity", run: "run-integrity", token: "runtime-integrity")
  _ = try integrityStore.begin(integrityStart)
  try complete(integrityStore, try integrityStore.claimFirstIncomplete(integrityStart, recordingActive: false)!, text: "first")
  try complete(integrityStore, try integrityStore.claimFirstIncomplete(integrityStart, recordingActive: false)!, text: "second")
  _ = try integrityStore.readResult(
    ownerUserId: "owner-a", meetingId: "meeting-integrity", runId: "run-integrity", generation: 1
  )
  try executeSQLite(
    integrityURL,
    "UPDATE runs SET result_json = replace(result_json, '\"disposition\":\"complete\"', '\"disposition\":\"partial\"') "
      + "WHERE meeting_id = 'meeting-integrity'"
  )
  expectThrows(.storageFailure("terminal_result_invalid"), "tampered terminal payload is rejected before disclosure") {
    _ = try integrityStore.readResult(
      ownerUserId: "owner-a", meetingId: "meeting-integrity", runId: "run-integrity", generation: 1
    )
  }

  let releaseStart = makeStart(meeting: "meeting-release", run: "run-release", token: "runtime-release")
  _ = try reopened.begin(releaseStart)
  _ = try reopened.claimFirstIncomplete(releaseStart, recordingActive: false)
  expect(try reopened.releaseRuntime(runtimeOwnerToken: "wrong-owner", generation: 1) == false, "stale runtime release is rejected")
  expect(try reopened.releaseRuntime(runtimeOwnerToken: "runtime-release", generation: 1), "exact runtime release succeeds")
  expect(try reopened.debugState(ownerUserId: "owner-a", meetingId: "meeting-release") == "queued", "runtime release preserves durable run")

  let coordinatorURL = root.appendingPathComponent("coordinator.sqlite3")
  let coordinatorStore = try MainaNativePostProcessingStore(
    databaseURL: coordinatorURL,
    processInstanceToken: "coordinator-process"
  )
  let fake = FakeNativePostProcessingTranscriber()
  let events = NativePostProcessingEvents()
  let coordinator = MainaNativePostProcessingCoordinator(
    store: coordinatorStore,
    transcribe: fake.transcribe,
    releaseRecognizer: {},
    onChanged: events.append
  )
  let coordinatorStart = makeStart(meeting: "meeting-coordinator", run: "run-coordinator", token: "runtime-coordinator")
  let startSignal = DispatchSemaphore(value: 0)
  var coordinatorStarted = false
  coordinator.start(coordinatorStart) { result in
    if case .success = result { coordinatorStarted = true }
    startSignal.signal()
  }
  expect(startSignal.wait(timeout: .now() + 2) == .success && coordinatorStarted, "coordinator starts exact durable generation")
  waitUntil("coordinator claims its first durable window") { fake.pendingCount == 1 }
  expect(fake.maximumPending == 1, "coordinator has one recognizer callback owner")
  let eventKeys = Set(events.last?.keys ?? Dictionary<String, Any>().keys)
  expect(eventKeys == Set(["schemaVersion", "meetingId", "runId", "generation", "eventSequence"]),
    "coordinator event is identifier-only")

  coordinator.setRecordingActive(true)
  waitUntil("recording durably preempts the coordinator") {
    (try? coordinatorStore.debugState(ownerUserId: "owner-a", meetingId: "meeting-coordinator")) == "preempted"
  }
  fake.completeNext(.success(.init(
    text: "stale text", language: "en", vadStatus: "speech", vadEvidenceSha256: String(repeating: "c", count: 64)
  )))
  waitUntil("stale callback drains without starting under recording") { fake.pendingCount == 0 }
  expect(try coordinatorStore.readResult(
    ownerUserId: "owner-a", meetingId: "meeting-coordinator", runId: "run-coordinator", generation: 1
  ) == nil, "preempted stale callback cannot seal a result")

  coordinator.setRecordingActive(false)
  waitUntil("recording release wakes the first incomplete window") { fake.pendingCount == 1 }
  fake.completeNext(.success(.init(
    text: "first coordinator window", language: "en", vadStatus: "speech",
    vadEvidenceSha256: String(repeating: "c", count: 64)
  )))
  waitUntil("coordinator serially claims the second window") { fake.pendingCount == 1 }
  fake.completeNext(.success(.init(
    text: "coordinator window continues safely", language: "en", vadStatus: "speech",
    vadEvidenceSha256: String(repeating: "c", count: 64)
  )))
  waitUntil("coordinator seals the exact terminal result") {
    (try? coordinatorStore.readResult(
      ownerUserId: "owner-a", meetingId: "meeting-coordinator", runId: "run-coordinator", generation: 1
    )) != nil
  }
  expect(fake.maximumPending == 1, "coordinator never overlaps recognizer callbacks")
  let stitchedResult = try coordinatorStore.readResult(
    ownerUserId: "owner-a", meetingId: "meeting-coordinator", runId: "run-coordinator", generation: 1
  )!
  let stitchedWindows = stitchedResult["windows"] as? [[String: Any]]
  let stitchedBlocks = stitchedWindows?[1]["blocks"] as? [[String: Any]]
  expect(stitchedBlocks?.first?["text"] as? String == "continues safely",
    "coordinator removes exact overlap before the durable window commit")

  let releaseCoordinatorURL = root.appendingPathComponent("coordinator-release.sqlite3")
  let releaseCoordinatorStore = try MainaNativePostProcessingStore(
    databaseURL: releaseCoordinatorURL,
    processInstanceToken: "coordinator-release-process"
  )
  let releaseFake = FakeNativePostProcessingTranscriber()
  var releaseRecognizerCount = 0
  let releaseCoordinator = MainaNativePostProcessingCoordinator(
    store: releaseCoordinatorStore,
    transcribe: releaseFake.transcribe,
    releaseRecognizer: { releaseRecognizerCount += 1 },
    onChanged: { _ in }
  )
  let releaseCoordinatorStart = makeStart(
    meeting: "meeting-coordinator-release",
    run: "run-coordinator-release",
    token: "runtime-coordinator-release"
  )
  let releaseStartSignal = DispatchSemaphore(value: 0)
  releaseCoordinator.start(releaseCoordinatorStart) { _ in releaseStartSignal.signal() }
  expect(releaseStartSignal.wait(timeout: .now() + 2) == .success,
    "release coordinator start completes")
  waitUntil("release coordinator owns one decoder callback") { releaseFake.pendingCount == 1 }
  expect(try releaseCoordinator.releaseAsr(
    runtimeOwnerToken: "runtime-coordinator-release",
    generation: 1
  ), "continued-processing expiration releases the exact runtime")
  expect(releaseRecognizerCount == 1, "continued-processing expiration releases one recognizer")
  releaseFake.completeNext(.failure(.runtimeInterrupted))
  waitUntil("released stale callback drains") { releaseFake.pendingCount == 0 }
  Thread.sleep(forTimeInterval: 0.05)
  expect(releaseFake.pendingCount == 0,
    "expiration cannot restart ASR without a later explicit wake")
  let explicitWake = DispatchSemaphore(value: 0)
  releaseCoordinator.start(releaseCoordinatorStart) { _ in explicitWake.signal() }
  expect(explicitWake.wait(timeout: .now() + 2) == .success,
    "explicit wake reopens the durable generation")
  waitUntil("explicit wake resumes the first incomplete window") { releaseFake.pendingCount == 1 }

  let adapterClaim = MainaNativePostProcessingClaim(
    ownerUserId: "owner-a", meetingId: "meeting-adapter", runId: "run-adapter", generation: 1,
    windowKey: "window-adapter", windowIndex: 0,
    audioURI: "file:///synthetic/capture-00001.wav", audioStartMs: 500, audioEndMs: 2_500,
    coverageStartMs: 12_500, coverageEndMs: 14_500,
    analysisStartMs: 12_500, analysisEndMs: 14_500,
    runtimeOwnerToken: "runtime-adapter", claimNonce: "claim-adapter", attemptCount: 1, maxAttempts: 2
  )
  let qwenPayload: [String: Any] = [
    "outcome": "success", "text": "bounded transcript", "language": "en",
    "processingMs": 4, "durationMs": 2_000, "windowStartMs": 500, "windowEndMs": 2_500,
    "rmsDbfs": -32.0, "peakDbfs": -10.0, "speechExpected": true,
    "truncationSuspected": false, "tokenCount": 2, "maxNewTokens": 128,
    "engineId": "qwen3-0.6b-int8", "engineVersion": "sherpa-onnx-1.13.4-ios-no-tts",
  ]
  switch MainaNativePostProcessingQwenAdapter.recognition(payload: qwenPayload, claim: adapterClaim) {
  case .success(let recognition):
    expect(recognition.text == "bounded transcript" && recognition.vadStatus == "unavailable",
      "Qwen output maps to bounded native result evidence")
  case .failure:
    expect(false, "valid Qwen output must not fail")
  }
  var truncatedPayload = qwenPayload
  truncatedPayload["truncationSuspected"] = true
  expect(
    MainaNativePostProcessingQwenAdapter.recognition(payload: truncatedPayload, claim: adapterClaim)
      == .failure(.runtimeInterrupted),
    "token-cap output stays retryable instead of becoming durable text"
  )
  var extraPayload = qwenPayload
  extraPayload["rawError"] = "private"
  expect(
    MainaNativePostProcessingQwenAdapter.recognition(payload: extraPayload, claim: adapterClaim)
      == .failure(.runtimeInterrupted),
    "Qwen adapter rejects undeclared payload fields"
  )
}

@main
private enum MainaNativePostProcessingStoreTestMain {
  static func main() {
    do {
      try run()
      print("Maina native post-processing store tests passed (\(assertions) assertions).")
    } catch {
      FileHandle.standardError.write(Data("FAIL: unexpected error \(error)\n".utf8))
      exit(1)
    }
  }
}
