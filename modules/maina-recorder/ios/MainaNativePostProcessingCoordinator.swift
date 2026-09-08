import Foundation

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
    let released = try store.releaseRuntime(runtimeOwnerToken: runtimeOwnerToken, generation: generation)
    if released {
      releaseRecognizer()
      queue.async {
        self.emitAllChanged()
        self.drainAll()
      }
    }
    return released
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
        let text = recognition.text.trimmingCharacters(in: .whitespacesAndNewlines)
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
