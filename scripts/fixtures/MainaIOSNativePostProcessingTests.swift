import Foundation

private var assertions = 0

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

private func makeStart(
  owner: String = "owner-a",
  meeting: String = "meeting-a",
  run: String = "run-a",
  generation: Int = 1,
  token: String = "runtime-a",
  maxAttempts: Int = 2,
  fingerprint: String = String(repeating: "a", count: 64),
  firstAudioURI: String = "file:///synthetic/capture-00000.wav"
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
        coverageStartMs: 0,
        coverageEndMs: 10_000,
        analysisStartMs: 0,
        analysisEndMs: 11_000
      ),
      .init(
        index: 1,
        audioURI: "file:///synthetic/capture-00000.wav",
        coverageStartMs: 10_000,
        coverageEndMs: 20_000,
        analysisStartMs: 9_000,
        analysisEndMs: 20_000
      ),
    ],
    createdAtMs: 1_788_000_000_000
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

  let releaseStart = makeStart(meeting: "meeting-release", run: "run-release", token: "runtime-release")
  _ = try reopened.begin(releaseStart)
  _ = try reopened.claimFirstIncomplete(releaseStart, recordingActive: false)
  expect(try reopened.releaseRuntime(runtimeOwnerToken: "wrong-owner", generation: 1) == false, "stale runtime release is rejected")
  expect(try reopened.releaseRuntime(runtimeOwnerToken: "runtime-release", generation: 1), "exact runtime release succeeds")
  expect(try reopened.debugState(ownerUserId: "owner-a", meetingId: "meeting-release") == "queued", "runtime release preserves durable run")
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
