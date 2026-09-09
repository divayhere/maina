import CryptoKit
import Foundation

enum MainaNativePostProcessingBridgeError: Error, Equatable {
  case invalidRequest(String)
  case audioPlanInvalid(String)
}

struct MainaNativePostProcessingStartRequest: Equatable {
  let ownerUserId: String
  let meetingId: String
  let runId: String
  let generation: Int
  let audioFingerprintSha256: String
  let windowConfig: MainaNativePostProcessingWindowConfig
  let runtimeOwnerToken: String
}

struct MainaNativePostProcessingReadRequest: Equatable {
  let ownerUserId: String
  let meetingId: String
  let runId: String
  let generation: Int
}

struct MainaNativePostProcessingReleaseRequest: Equatable {
  let runtimeOwnerToken: String
  let generation: Int
}

struct MainaNativePostProcessingAudioSegment: Equatable {
  let audioURI: String
  let byteCount: Int64
  let durationMs: Int
  let sha256: String
}

/** Closed Expo dictionaries are decoded before any durable read or mutation. */
enum MainaNativePostProcessingBridgeCodec {
  private static let identifier = try! NSRegularExpression(pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
  private static let sha = try! NSRegularExpression(pattern: "^[a-f0-9]{64}$")

  static func start(_ value: [String: Any]) throws -> MainaNativePostProcessingStartRequest {
    try exactKeys(value, [
      "ownerUserId", "meetingId", "runId", "generation", "audioFingerprintSha256",
      "windowConfig", "runtimeOwnerToken",
    ], "start_shape_invalid")
    guard let windowConfig = value["windowConfig"] as? [String: Any] else {
      throw MainaNativePostProcessingBridgeError.invalidRequest("start_shape_invalid")
    }
    try exactKeys(windowConfig, ["targetWindowMs", "analysisOverlapMs", "maxAttempts"], "start_shape_invalid")
    let request = MainaNativePostProcessingStartRequest(
      ownerUserId: try id(value["ownerUserId"], "start_identity_invalid"),
      meetingId: try id(value["meetingId"], "start_identity_invalid"),
      runId: try id(value["runId"], "start_identity_invalid"),
      generation: try positiveInt(value["generation"], "start_identity_invalid"),
      audioFingerprintSha256: try digest(value["audioFingerprintSha256"], "start_identity_invalid"),
      windowConfig: .init(
        targetWindowMs: try int(windowConfig["targetWindowMs"], "start_shape_invalid"),
        analysisOverlapMs: try int(windowConfig["analysisOverlapMs"], "start_shape_invalid"),
        maxAttempts: try int(windowConfig["maxAttempts"], "start_shape_invalid")
      ),
      runtimeOwnerToken: try id(value["runtimeOwnerToken"], "start_identity_invalid")
    )
    guard request.windowConfig.targetWindowMs >= 1_000, request.windowConfig.targetWindowMs <= 600_000,
      request.windowConfig.analysisOverlapMs >= 0, request.windowConfig.analysisOverlapMs <= 30_000,
      request.windowConfig.analysisOverlapMs < request.windowConfig.targetWindowMs,
      request.windowConfig.maxAttempts >= 1, request.windowConfig.maxAttempts <= 10
    else { throw MainaNativePostProcessingBridgeError.invalidRequest("start_shape_invalid") }
    return request
  }

  static func read(_ value: [String: Any]) throws -> MainaNativePostProcessingReadRequest {
    try exactKeys(value, ["ownerUserId", "meetingId", "runId", "generation"], "read_shape_invalid")
    return .init(
      ownerUserId: try id(value["ownerUserId"], "read_identity_invalid"),
      meetingId: try id(value["meetingId"], "read_identity_invalid"),
      runId: try id(value["runId"], "read_identity_invalid"),
      generation: try positiveInt(value["generation"], "read_identity_invalid")
    )
  }

  static func acknowledge(_ value: [String: Any]) throws -> MainaNativePostProcessingImportFence {
    try exactKeys(value, [
      "schemaVersion", "state", "ownerUserId", "meetingId", "runId", "generation", "resultId",
      "resultPayloadSha256", "importedAt", "transactionCommitSha256",
    ], "acknowledgement_shape_invalid")
    guard value["schemaVersion"] as? String == "maina.native-post-processing-import-fence.v1",
      value["state"] as? String == "DURABLE"
    else { throw MainaNativePostProcessingBridgeError.invalidRequest("acknowledgement_shape_invalid") }
    return .init(
      schemaVersion: "maina.native-post-processing-import-fence.v1",
      state: "DURABLE",
      ownerUserId: try id(value["ownerUserId"], "acknowledgement_identity_invalid"),
      meetingId: try id(value["meetingId"], "acknowledgement_identity_invalid"),
      runId: try id(value["runId"], "acknowledgement_identity_invalid"),
      generation: try positiveInt(value["generation"], "acknowledgement_identity_invalid"),
      resultId: try id(value["resultId"], "acknowledgement_identity_invalid"),
      resultPayloadSha256: try digest(value["resultPayloadSha256"], "acknowledgement_identity_invalid"),
      importedAt: try nonempty(value["importedAt"], maximum: 64, "acknowledgement_shape_invalid"),
      transactionCommitSha256: try digest(value["transactionCommitSha256"], "acknowledgement_identity_invalid")
    )
  }

  static func release(_ value: [String: Any]) throws -> MainaNativePostProcessingReleaseRequest {
    try exactKeys(value, ["runtimeOwnerToken", "generation"], "release_shape_invalid")
    return .init(
      runtimeOwnerToken: try id(value["runtimeOwnerToken"], "release_identity_invalid"),
      generation: try positiveInt(value["generation"], "release_identity_invalid")
    )
  }

  private static func exactKeys(_ value: [String: Any], _ expected: Set<String>, _ code: String) throws {
    guard Set(value.keys) == expected else { throw MainaNativePostProcessingBridgeError.invalidRequest(code) }
  }

  private static func id(_ value: Any?, _ code: String) throws -> String {
    let string = try nonempty(value, maximum: 128, code)
    guard identifier.firstMatch(in: string, range: NSRange(string.startIndex..., in: string)) != nil else {
      throw MainaNativePostProcessingBridgeError.invalidRequest(code)
    }
    return string
  }

  private static func digest(_ value: Any?, _ code: String) throws -> String {
    guard let string = value as? String,
      sha.firstMatch(in: string, range: NSRange(string.startIndex..., in: string)) != nil
    else { throw MainaNativePostProcessingBridgeError.invalidRequest(code) }
    return string
  }

  private static func nonempty(_ value: Any?, maximum: Int, _ code: String) throws -> String {
    guard let string = value as? String, !string.isEmpty, string.count <= maximum else {
      throw MainaNativePostProcessingBridgeError.invalidRequest(code)
    }
    return string
  }

  private static func int(_ value: Any?, _ code: String) throws -> Int {
    if let number = value as? Int { return number }
    if let number = value as? Double, number.isFinite, number.rounded(.towardZero) == number,
      number >= Double(Int.min), number <= Double(Int.max) {
      return Int(number)
    }
    throw MainaNativePostProcessingBridgeError.invalidRequest(code)
  }

  private static func positiveInt(_ value: Any?, _ code: String) throws -> Int {
    let number = try int(value, code)
    guard number > 0 else { throw MainaNativePostProcessingBridgeError.invalidRequest(code) }
    return number
  }
}

/**
 * Converts immutable WAV identities into a global, gap-free coverage plan while
 * retaining source-local decoder offsets for every independently finalized file.
 */
enum MainaNativePostProcessingAudioPlanner {
  static func loadSegments(
    uris: [String],
    durations: [String: Any]
  ) throws -> [MainaNativePostProcessingAudioSegment] {
    let ordered = uris.sorted { left, right in
      (URL(string: left)?.lastPathComponent ?? left) < (URL(string: right)?.lastPathComponent ?? right)
    }
    return try ordered.map { uri in
      guard let url = URL(string: uri), url.isFileURL,
        let duration = durations[uri] as? Double, duration.isFinite, duration > 0,
        let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
        let type = attributes[.type] as? FileAttributeType, type == .typeRegular,
        let byteCount = (attributes[.size] as? NSNumber)?.int64Value, byteCount > 44
      else { throw MainaNativePostProcessingBridgeError.audioPlanInvalid("audio_segments_invalid") }
      let values = try url.resourceValues(forKeys: [.isSymbolicLinkKey])
      guard values.isSymbolicLink != true else {
        throw MainaNativePostProcessingBridgeError.audioPlanInvalid("audio_segments_invalid")
      }
      let handle = try FileHandle(forReadingFrom: url)
      defer { try? handle.close() }
      var hasher = SHA256()
      while true {
        guard let chunk = try handle.read(upToCount: 1_048_576), !chunk.isEmpty else { break }
        hasher.update(data: chunk)
      }
      let sha = hasher.finalize().map { String(format: "%02x", $0) }.joined()
      return .init(
        audioURI: uri,
        byteCount: byteCount,
        durationMs: Int(duration.rounded(.down)),
        sha256: sha
      )
    }
  }

  static func fingerprint(_ segments: [MainaNativePostProcessingAudioSegment]) throws -> String {
    try validate(segments)
    let payload = segments.enumerated().map { index, segment in
      [
        "index": index,
        "fileName": URL(string: segment.audioURI)?.lastPathComponent ?? "",
        "byteCount": segment.byteCount,
        "durationMs": segment.durationMs,
        "sha256": segment.sha256,
      ] as [String: Any]
    }
    let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  static func makeStart(
    request: MainaNativePostProcessingStartRequest,
    segments: [MainaNativePostProcessingAudioSegment],
    modelVersion: String,
    runtimeVersion: String,
    createdAtMs: Int64
  ) throws -> MainaNativePostProcessingStart {
    guard try fingerprint(segments) == request.audioFingerprintSha256 else {
      throw MainaNativePostProcessingBridgeError.audioPlanInvalid("audio_fingerprint_mismatch")
    }
    var windows: [MainaNativePostProcessingWindowPlan] = []
    var globalSegmentStart = 0
    for segment in segments {
      var localCoverageStart = 0
      while localCoverageStart < segment.durationMs {
        let localCoverageEnd = min(segment.durationMs, localCoverageStart + request.windowConfig.targetWindowMs)
        let localAnalysisStart = max(0, localCoverageStart - request.windowConfig.analysisOverlapMs)
        windows.append(.init(
          index: windows.count,
          audioURI: segment.audioURI,
          audioStartMs: localAnalysisStart,
          audioEndMs: localCoverageEnd,
          coverageStartMs: globalSegmentStart + localCoverageStart,
          coverageEndMs: globalSegmentStart + localCoverageEnd,
          analysisStartMs: globalSegmentStart + localAnalysisStart,
          analysisEndMs: globalSegmentStart + localCoverageEnd
        ))
        localCoverageStart = localCoverageEnd
      }
      globalSegmentStart += segment.durationMs
    }
    return .init(
      ownerUserId: request.ownerUserId,
      meetingId: request.meetingId,
      runId: request.runId,
      generation: request.generation,
      audioFingerprintSha256: request.audioFingerprintSha256,
      contractVersion: "1.0",
      modelId: "qwen3-0.6b-int8",
      modelVersion: modelVersion,
      runtimeVersion: runtimeVersion,
      runtimeOwnerToken: request.runtimeOwnerToken,
      audioDurationMs: globalSegmentStart,
      segmentCount: segments.count,
      windowConfig: request.windowConfig,
      windows: windows,
      createdAtMs: createdAtMs
    )
  }

  private static func validate(_ segments: [MainaNativePostProcessingAudioSegment]) throws {
    let captureName = try! NSRegularExpression(pattern: "^capture-[0-9]{5}\\.wav$")
    let digest = try! NSRegularExpression(pattern: "^[a-f0-9]{64}$")
    guard !segments.isEmpty, segments.count <= 10_000 else {
      throw MainaNativePostProcessingBridgeError.audioPlanInvalid("audio_segments_invalid")
    }
    var names = Set<String>()
    for segment in segments {
      guard let url = URL(string: segment.audioURI), url.isFileURL,
        segment.byteCount > 44, segment.durationMs > 0,
        captureName.firstMatch(in: url.lastPathComponent, range: NSRange(url.lastPathComponent.startIndex..., in: url.lastPathComponent)) != nil,
        digest.firstMatch(in: segment.sha256, range: NSRange(segment.sha256.startIndex..., in: segment.sha256)) != nil,
        names.insert(url.lastPathComponent).inserted
      else { throw MainaNativePostProcessingBridgeError.audioPlanInvalid("audio_segments_invalid") }
    }
  }
}

enum MainaNativePostProcessingQwenAdapter {
  static func recognition(
    payload: [String: Any],
    claim: MainaNativePostProcessingClaim
  ) -> Result<MainaNativePostProcessingRecognition, MainaNativePostProcessingRecognitionFailure> {
    let expected = Set([
      "outcome", "text", "language", "processingMs", "durationMs", "windowStartMs", "windowEndMs",
      "rmsDbfs", "peakDbfs", "speechExpected", "truncationSuspected", "tokenCount", "maxNewTokens",
      "engineId", "engineVersion",
    ])
    guard Set(payload.keys) == expected,
      let outcome = payload["outcome"] as? String, ["success", "empty"].contains(outcome),
      let text = payload["text"] as? String, text.count <= 8_192,
      (outcome == "empty") == text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      let languageValue = payload["language"] as? String,
      let processingMs = payload["processingMs"] as? Int, processingMs >= 0,
      let durationMs = payload["durationMs"] as? Int, durationMs > 0,
      let windowStartMs = payload["windowStartMs"] as? Int,
      let windowEndMs = payload["windowEndMs"] as? Int,
      let tokenCount = payload["tokenCount"] as? Int, tokenCount >= 0, tokenCount <= 128,
      payload["maxNewTokens"] as? Int == 128,
      payload["rmsDbfs"] is Double, payload["peakDbfs"] is Double,
      payload["speechExpected"] is Bool,
      let truncation = payload["truncationSuspected"] as? Bool,
      payload["engineId"] as? String == "qwen3-0.6b-int8",
      payload["engineVersion"] as? String == "sherpa-onnx-1.13.4-ios-no-tts",
      windowStartMs == claim.audioStartMs,
      windowEndMs == claim.audioEndMs,
      durationMs == windowEndMs - windowStartMs
    else { return .failure(.runtimeInterrupted) }
    guard !truncation else { return .failure(.runtimeInterrupted) }
    let languageCandidate = languageValue.trimmingCharacters(in: .whitespacesAndNewlines)
    let language = languageCandidate.range(of: "^[A-Za-z][A-Za-z0-9-]{1,15}$", options: .regularExpression) != nil
      ? languageCandidate : "und"
    let evidence: [String: Any] = [
      "engineId": "qwen3-0.6b-int8",
      "engineVersion": "sherpa-onnx-1.13.4-ios-no-tts",
      "outcome": outcome,
      "speechExpected": payload["speechExpected"] as? Bool ?? false,
      "windowStartMs": claim.audioStartMs,
      "windowEndMs": claim.audioEndMs,
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: evidence, options: [.sortedKeys]) else {
      return .failure(.runtimeInterrupted)
    }
    let evidenceSha = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    return .success(.init(text: text, language: language, vadStatus: "unavailable", vadEvidenceSha256: evidenceSha))
  }

  static func failure(_ error: Error) -> MainaNativePostProcessingRecognitionFailure {
    let code = (error as NSError).code
    if code == 1_101 { return .modelUnavailable }
    if [1_102, 1_106, 1_107, 1_108].contains(code) { return .audioUnreadable }
    return .runtimeInterrupted
  }
}

enum MainaNativePostProcessingTranscriptStitcher {
  static func removeExactOverlap(previous: String, current: String, maxWords: Int = 24) -> String {
    let previousWords = words(previous)
    let currentWords = words(current)
    let limit = min(max(0, maxWords), previousWords.count, currentWords.count)
    guard limit >= 2 else { return current.trimmingCharacters(in: .whitespacesAndNewlines) }
    for count in stride(from: limit, through: 2, by: -1) {
      let tail = previousWords.suffix(count).map(normalizedToken)
      let head = currentWords.prefix(count).map(normalizedToken)
      if zip(tail, head).allSatisfy({ !$0.0.isEmpty && $0.0 == $0.1 }) {
        return currentWords.dropFirst(count).joined(separator: " ")
          .trimmingCharacters(in: .whitespacesAndNewlines)
      }
    }
    return current.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private static func words(_ value: String) -> [Substring] {
    value.split(whereSeparator: { $0.isWhitespace })
  }

  private static func normalizedToken(_ value: Substring) -> String {
    String(value).lowercased().unicodeScalars
      .filter { CharacterSet.alphanumerics.contains($0) }
      .map(String.init)
      .joined()
  }
}

struct MainaNativePostProcessingRecognition: Equatable {
  let text: String
  let language: String
  let vadStatus: String
  let vadEvidenceSha256: String
}

enum MainaNativePostProcessingRecognitionFailure: Error, Equatable {
  case modelUnavailable
  case runtimeInterrupted
  case audioUnreadable

  var reasonCode: String {
    switch self {
    case .modelUnavailable: return "MODEL_UNAVAILABLE"
    case .runtimeInterrupted: return "RUNTIME_INTERRUPTED"
    case .audioUnreadable: return "AUDIO_UNREADABLE"
    }
  }
}

/**
 * The coordinator is intentionally a wake executor, never durable authority.
 * Every wake rereads MainaNativePostProcessingStore, every callback is fenced
 * by its durable claim, and emitted events contain identifiers only.
 */
final class MainaNativePostProcessingCoordinator {
  typealias Transcribe = (
    MainaNativePostProcessingClaim,
    @escaping (Result<MainaNativePostProcessingRecognition, MainaNativePostProcessingRecognitionFailure>) -> Void
  ) -> Void
  typealias ReleaseRecognizer = () -> Void
  typealias Changed = ([String: Any]) -> Void

  private let queue: DispatchQueue
  private let store: MainaNativePostProcessingStore
  private let transcribe: Transcribe
  private let releaseRecognizer: ReleaseRecognizer
  private let onChanged: Changed
  private var knownStarts: [String: MainaNativePostProcessingStart] = [:]
  private var recordingActive = false
  private var inferenceInFlight = false

  init(
    store: MainaNativePostProcessingStore,
    queue: DispatchQueue = DispatchQueue(label: "com.divay.maina.ios.native-post-processing", qos: .utility),
    transcribe: @escaping Transcribe,
    releaseRecognizer: @escaping ReleaseRecognizer,
    onChanged: @escaping Changed
  ) {
    self.store = store
    self.queue = queue
    self.transcribe = transcribe
    self.releaseRecognizer = releaseRecognizer
    self.onChanged = onChanged
  }

  func start(
    _ input: MainaNativePostProcessingStart,
    completion: @escaping (Result<MainaNativePostProcessingStartResult, Error>) -> Void
  ) {
    queue.async {
      do {
        let result = try self.store.begin(input)
        self.knownStarts[self.key(input)] = input
        self.emitChanged(input)
        completion(.success(result))
        self.drainAll()
      } catch {
        completion(.failure(error))
      }
    }
  }

  func wake(_ input: MainaNativePostProcessingStart) {
    queue.async {
      do {
        _ = try self.store.begin(input)
        self.knownStarts[self.key(input)] = input
        self.drainAll()
      } catch {
        // A wake is identifier-only and cannot replace conflicting durable truth.
      }
    }
  }

  func setRecordingActive(_ active: Bool) {
    queue.async {
      do {
        self.recordingActive = active
        try self.store.setRecordingActive(active)
        self.emitAllChanged()
        if !active { self.drainAll() }
      } catch {
        // The WAL remains authoritative and fail-closed if a state write fails.
      }
    }
  }

  func readResult(
    ownerUserId: String,
    meetingId: String,
    runId: String,
    generation: Int
  ) throws -> [String: Any]? {
    try store.readResult(
      ownerUserId: ownerUserId,
      meetingId: meetingId,
      runId: runId,
      generation: generation
    )
  }

  func acknowledge(_ fence: MainaNativePostProcessingImportFence) throws -> Bool {
    let acknowledged = try store.acknowledge(fence)
    if acknowledged {
      queue.async { self.emitChanged(fence) }
    }
    return acknowledged
  }

  func releaseAsr(runtimeOwnerToken: String, generation: Int) throws -> Bool {
    try queue.sync {
      let released = try store.releaseRuntime(
        runtimeOwnerToken: runtimeOwnerToken,
        generation: generation
      )
      guard released else { return false }
      // Continued-processing expiration is not itself a new wake. Remove the
      // in-memory start owner before the stale decoder callback returns, so
      // finish() cannot immediately reclaim the runtime that was just
      // released. The next explicit foreground/background wake re-adds the
      // same immutable start identity and resumes from the WAL.
      knownStarts = knownStarts.filter { _, input in
        input.runtimeOwnerToken != runtimeOwnerToken || input.generation != generation
      }
      releaseRecognizer()
      emitAllChanged()
      return true
    }
  }

  private func drainAll() {
    guard !recordingActive, !inferenceInFlight else { return }
    for input in knownStarts.values.sorted(by: { key($0) < key($1) }) {
      do {
        if let claim = try store.claimFirstIncomplete(input, recordingActive: false) {
          inferenceInFlight = true
          emitChanged(input)
          transcribe(claim) { result in
            self.queue.async { self.finish(claim: claim, input: input, result: result) }
          }
          return
        }
      } catch {
        emitChanged(input)
      }
    }
  }

  private func finish(
    claim: MainaNativePostProcessingClaim,
    input: MainaNativePostProcessingStart,
    result: Result<MainaNativePostProcessingRecognition, MainaNativePostProcessingRecognitionFailure>
  ) {
    defer {
      inferenceInFlight = false
      emitChanged(input)
      drainAll()
    }
    do {
      switch result {
      case .success(let recognition):
        let previousText = try store.precedingTranscriptText(for: claim)
        let text = MainaNativePostProcessingTranscriptStitcher.removeExactOverlap(
          previous: previousText,
          current: recognition.text
        )
        let blocks = text.isEmpty ? [] : [MainaNativePostProcessingBlockInput(
          startedAtMs: claim.coverageStartMs,
          endedAtMs: claim.coverageEndMs,
          text: text,
          language: recognition.language
        )]
        _ = try store.commitWindow(
          claim: claim,
          blocks: blocks,
          vad: .init(status: recognition.vadStatus, evidenceSha256: recognition.vadEvidenceSha256)
        )
      case .failure(let failure):
        _ = try store.failWindow(claim: claim, reasonCode: failure.reasonCode)
      }
    } catch {
      // Invalid or stale callbacks cannot gain a second mutation path.
    }
  }

  private func emitAllChanged() {
    for input in knownStarts.values { emitChanged(input) }
  }

  private func emitChanged(_ input: MainaNativePostProcessingStart) {
    if let event = try? store.changedEvent(
      ownerUserId: input.ownerUserId,
      meetingId: input.meetingId,
      runId: input.runId,
      generation: input.generation
    ) {
      onChanged(event)
    }
  }

  private func emitChanged(_ fence: MainaNativePostProcessingImportFence) {
    if let event = try? store.changedEvent(
      ownerUserId: fence.ownerUserId,
      meetingId: fence.meetingId,
      runId: fence.runId,
      generation: fence.generation
    ) {
      onChanged(event)
    }
  }

  private func key(_ input: MainaNativePostProcessingStart) -> String {
    "\(input.ownerUserId)|\(input.meetingId)|\(input.runId)|\(input.generation)"
  }
}
