import BackgroundTasks
import CryptoKit
import Foundation
import UIKit

/**
 * Monitors foreground-started local ASR without becoming its data owner.
 * SQLite per-window claims remain canonical; this registry only binds an OS
 * assertion to one meeting/generation and fences expiration exactly once.
 */
public final class MainaIOSContinuedProcessing {
  public static let shared = MainaIOSContinuedProcessing()

  private final class CompletionGate {
    private let lock = NSLock()
    private var completed = false
    private let task: BGTask

    init(task: BGTask) { self.task = task }

    var isActive: Bool {
      lock.lock()
      defer { lock.unlock() }
      return !completed
    }

    @discardableResult
    func complete(success: Bool) -> Bool {
      lock.lock()
      guard !completed else {
        lock.unlock()
        return false
      }
      completed = true
      lock.unlock()
      task.setTaskCompleted(success: success)
      return true
    }

    @available(iOS 26.0, *)
    func updateProgress(completedUnits: Int64, total: Int64, subtitle: String?) {
      lock.lock()
      let shouldUpdate = !completed
      lock.unlock()
      guard shouldUpdate, let continued = task as? BGContinuedProcessingTask else { return }
      continued.progress.totalUnitCount = total
      continued.progress.completedUnitCount = min(completedUnits, total)
      if let subtitle, !subtitle.isEmpty {
        continued.updateTitle("Preparing meeting transcript", subtitle: subtitle)
      }
    }
  }

  private struct Submission: Codable {
    enum State: String, Codable {
      case pending, attached, deferralRequested, deferred, complete
    }

    let identifier: String
    let meetingId: String
    let runSequence: Int
    var asrGeneration: Int?
    let createdAt: TimeInterval
    var attachedAt: TimeInterval?
    var deferralRequestedAt: TimeInterval?
    var deferredAt: TimeInterval?
    var completedAt: TimeInterval?
    var lifecycleUpdatedAt: TimeInterval
    var state: State
  }

  private struct LegacySubmission: Codable {
    enum State: String, Codable { case pending, attached, deferred, complete }
    let identifier: String
    let meetingId: String
    let createdAt: TimeInterval
    var state: State
    var completedAt: TimeInterval?
  }

  private enum Key {
    static let registry = "maina.continuedProcessing.registry.v3"
    static let legacyRegistry = "maina.continuedProcessing.registry.v2"
    static let sequence = "maina.continuedProcessing.sequence.v3"
    static let legacySequence = "maina.continuedProcessing.sequence.v2"
  }

  private let queue = DispatchQueue(label: "com.divay.maina.ios.continued-processing")
  private let requestIdentifierPrefix = "com.divay.maina.staging.continued-processing.transcription"
  private let defaults = UserDefaults.standard
  private var registeredIdentifiers = Set<String>()
  private var gates: [String: CompletionGate] = [:]
  private var claimedIdentifiers = Set<String>()
  private var fallbackTasks: [String: UIBackgroundTaskIdentifier] = [:]
  private var progressByIdentifier: [String: (completed: Int64, total: Int64)] = [:]
  private var deferralHandler: (([String: Any]) -> Void)?

  private init() {}

  public func configure(onDeferralRequested: @escaping ([String: Any]) -> Void) {
    queue.async { self.deferralHandler = onDeferralRequested }
  }

  /** Register exact persisted identifiers before RN starts after relaunch. */
  public static func registerLaunchHandler() {
    guard #available(iOS 26.0, *) else { return }
    shared.queue.sync {
      var registry = shared.loadRegistry()
      shared.pruneRegistry(&registry)
      shared.saveRegistry(registry)
      for submission in registry where submission.state == .pending || submission.state == .attached {
        guard MainaIOSContinuedProcessingRetentionPolicy.mayRegister(
          identifier: submission.identifier,
          registered: shared.registeredIdentifiers
        ) else { break }
        _ = shared.registerExactIdentifierIfNeeded(submission.identifier)
      }
    }
  }

  func begin(jobId: String, title: String, subtitle: String, totalUnits: Int) -> [String: Any] {
    queue.sync {
      if #available(iOS 26.0, *), UIApplication.shared.applicationState == .active {
        var registry = loadRegistry()
        pruneRegistry(&registry)

        if let existing = registry.last(where: {
          $0.meetingId == jobId && ($0.state == .pending || $0.state == .attached)
        }) {
          claimedIdentifiers.insert(existing.identifier)
          progressByIdentifier[existing.identifier] = (0, Int64(max(1, totalUnits)))
          saveRegistry(registry)
          beginFallbackTask(identifier: existing.identifier)
          return [
            "started": true,
            "mode": gates[existing.identifier]?.isActive == true ? "attached-existing" : "pending-existing",
            "requestId": existing.identifier,
          ]
        }

        let identity = makeUniqueIdentifier(meetingId: jobId)
        let now = Date().timeIntervalSince1970
        registry.append(Submission(
          identifier: identity.identifier,
          meetingId: jobId,
          runSequence: identity.sequence,
          asrGeneration: nil,
          createdAt: now,
          attachedAt: nil,
          deferralRequestedAt: nil,
          deferredAt: nil,
          completedAt: nil,
          lifecycleUpdatedAt: now,
          state: .pending
        ))
        pruneRegistry(&registry)
        saveRegistry(registry) // Persist before registration/submission.
        progressByIdentifier[identity.identifier] = (0, Int64(max(1, totalUnits)))

        guard registerExactIdentifierIfNeeded(identity.identifier) else {
          beginFallbackTask(identifier: identity.identifier)
          if fallbackTasks[identity.identifier] == nil {
            markSubmission(identity.identifier, state: .deferred)
          }
          return [
            "started": fallbackTasks[identity.identifier] != nil,
            "mode": "fallback",
            "reason": "continued-processing-handler-unregistered",
            "requestId": identity.identifier,
          ]
        }

        claimedIdentifiers.insert(identity.identifier)
        let request = BGContinuedProcessingTaskRequest(
          identifier: identity.identifier,
          title: title,
          subtitle: subtitle
        )
        request.strategy = .fail
        do {
          try BGTaskScheduler.shared.submit(request)
          beginFallbackTask(identifier: identity.identifier)
          return [
            "started": true,
            "mode": "continued-processing-requested",
            "requestId": identity.identifier,
          ]
        } catch {
          beginFallbackTask(identifier: identity.identifier)
          if fallbackTasks[identity.identifier] == nil {
            markSubmission(identity.identifier, state: .deferred)
          }
          return [
            "started": fallbackTasks[identity.identifier] != nil,
            "mode": "fallback",
            "reason": "continued-processing-submit-\((error as NSError).code)",
            "requestId": identity.identifier,
          ]
        }
      }

      return [
        "started": false,
        "mode": "existing-background-owner",
        "reason": "continued-processing-requires-foreground",
      ]
    }
  }

  func bindRun(identifier: String, meetingId: String, asrGeneration: Int) -> Bool {
    queue.sync {
      var registry = loadRegistry()
      guard let index = registry.lastIndex(where: {
        $0.identifier == identifier
          && $0.meetingId == meetingId
          && ($0.state == .pending || $0.state == .attached)
      }) else { return false }
      registry[index].asrGeneration = asrGeneration
      registry[index].lifecycleUpdatedAt = Date().timeIntervalSince1970
      saveRegistry(registry)
      return true
    }
  }

  func update(identifier: String, completedUnits: Int, totalUnits: Int, subtitle: String?) {
    queue.async {
      guard self.isIdentifierActive(identifier) else { return }
      let progress = (Int64(max(0, completedUnits)), Int64(max(1, totalUnits)))
      self.progressByIdentifier[identifier] = progress
      guard #available(iOS 26.0, *), let gate = self.gates[identifier], gate.isActive else { return }
      gate.updateProgress(completedUnits: progress.0, total: progress.1, subtitle: subtitle)
    }
  }

  func finish(identifier: String, success: Bool) {
    queue.async {
      self.complete(identifier: identifier, success: success, state: success ? .complete : .deferred)
    }
  }

  func acknowledgeDeferral(identifier: String, meetingId: String, asrGeneration: Int) -> Bool {
    queue.sync {
      let registry = loadRegistry()
      guard registry.contains(where: {
        $0.identifier == identifier
          && $0.meetingId == meetingId
          && $0.asrGeneration == asrGeneration
          && $0.state == .deferralRequested
      }) else { return false }
      complete(identifier: identifier, success: false, state: .deferred)
      return true
    }
  }

  func isActive(identifier: String, meetingId: String) -> Bool {
    queue.sync {
      guard !identifier.isEmpty else { return false }
      if fallbackTasks[identifier] != nil { return true }
      guard let submission = loadRegistry().last(where: {
        $0.identifier == identifier
          && $0.meetingId == meetingId
          && ($0.state == .pending || $0.state == .attached)
      }) else { return false }
      if gates[submission.identifier]?.isActive == true { return true }
      return UIApplication.shared.applicationState == .active
    }
  }

  @available(iOS 26.0, *)
  private func registerExactIdentifierIfNeeded(_ identifier: String) -> Bool {
    if registeredIdentifiers.contains(identifier) { return true }
    guard MainaIOSContinuedProcessingRetentionPolicy.mayRegister(
      identifier: identifier,
      registered: registeredIdentifiers
    ) else { return false }
    let registered = BGTaskScheduler.shared.register(
      forTaskWithIdentifier: identifier,
      using: queue
    ) { [weak self] task in
      self?.attach(task, identifier: identifier)
    }
    if registered { registeredIdentifiers.insert(identifier) }
    return registered
  }

  private func attach(_ task: BGTask, identifier: String) {
    let registry = loadRegistry()
    guard registry.contains(where: {
      $0.identifier == identifier && ($0.state == .pending || $0.state == .attached)
    }), gates[identifier] == nil else {
      task.setTaskCompleted(success: false)
      return
    }
    let gate = CompletionGate(task: task)
    gates[identifier] = gate
    markSubmission(identifier, state: .attached)
    endFallbackTask(identifier: identifier)
    task.expirationHandler = { [weak self, weak gate] in
      guard let self, let gate else { return }
      self.queue.async { self.requestDeferral(identifier: identifier, gate: gate) }
    }
    if #available(iOS 26.0, *), let progress = progressByIdentifier[identifier],
      let continued = task as? BGContinuedProcessingTask {
      continued.progress.totalUnitCount = progress.total
      continued.progress.completedUnitCount = min(progress.completed, progress.total)
    }

    queue.asyncAfter(deadline: .now() + .seconds(10)) { [weak self, weak gate] in
      guard let self, let gate,
        self.gates[identifier] === gate,
        !self.claimedIdentifiers.contains(identifier)
      else { return }
      self.complete(identifier: identifier, success: false, state: .deferred)
    }
  }

  private func requestDeferral(identifier: String, gate: CompletionGate) {
    guard gates[identifier] === gate, gate.isActive else { return }
    var registry = loadRegistry()
    guard let index = registry.lastIndex(where: {
      $0.identifier == identifier && ($0.state == .pending || $0.state == .attached)
    }) else {
      complete(identifier: identifier, success: false, state: .deferred)
      return
    }
    let now = Date().timeIntervalSince1970
    registry[index].state = .deferralRequested
    registry[index].deferralRequestedAt = now
    registry[index].lifecycleUpdatedAt = now
    let submission = registry[index]
    saveRegistry(registry)

    if let generation = submission.asrGeneration {
      deferralHandler?([
        "requestId": identifier,
        "meetingId": submission.meetingId,
        "asrGeneration": generation,
        "occurredAt": Int64(now * 1_000),
      ])
    }

    queue.asyncAfter(deadline: .now() + .seconds(1)) { [weak self, weak gate] in
      guard let self, let gate, self.gates[identifier] === gate, gate.isActive else { return }
      self.complete(identifier: identifier, success: false, state: .deferred)
    }
  }

  private func complete(identifier: String, success: Bool, state: Submission.State) {
    if let gate = gates.removeValue(forKey: identifier) {
      _ = gate.complete(success: success)
    } else if #available(iOS 13.0, *) {
      BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
    }
    claimedIdentifiers.remove(identifier)
    progressByIdentifier.removeValue(forKey: identifier)
    markSubmission(identifier, state: state)
    endFallbackTask(identifier: identifier)
  }

  private func isIdentifierActive(_ identifier: String) -> Bool {
    loadRegistry().contains(where: {
      $0.identifier == identifier && ($0.state == .pending || $0.state == .attached)
    })
  }

  private func makeUniqueIdentifier(meetingId: String) -> (identifier: String, sequence: Int) {
    let digest = SHA256.hash(data: Data(meetingId.utf8)).prefix(8)
      .map { String(format: "%02x", $0) }.joined()
    let sequence = max(defaults.integer(forKey: Key.sequence), defaults.integer(forKey: Key.legacySequence)) + 1
    defaults.set(sequence, forKey: Key.sequence)
    let nonce = UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(8).lowercased()
    return ("\(requestIdentifierPrefix).\(digest).\(sequence).\(nonce)", sequence)
  }

  private func loadRegistry() -> [Submission] {
    if let data = defaults.data(forKey: Key.registry),
      let value = try? JSONDecoder().decode([Submission].self, from: data) {
      return value
    }
    guard let data = defaults.data(forKey: Key.legacyRegistry),
      let legacy = try? JSONDecoder().decode([LegacySubmission].self, from: data)
    else { return [] }
    let migrated = legacy.map { item in
      let sequence = Int(item.identifier.split(separator: ".").dropLast().last ?? "0") ?? 0
      return Submission(
        identifier: item.identifier,
        meetingId: item.meetingId,
        runSequence: sequence,
        asrGeneration: nil,
        createdAt: item.createdAt,
        attachedAt: item.state == .attached ? item.createdAt : nil,
        deferralRequestedAt: nil,
        deferredAt: item.state == .deferred ? (item.completedAt ?? item.createdAt) : nil,
        completedAt: item.state == .complete ? (item.completedAt ?? item.createdAt) : nil,
        lifecycleUpdatedAt: item.completedAt ?? item.createdAt,
        state: item.state == .pending ? .pending
          : item.state == .attached ? .attached
          : item.state == .complete ? .complete : .deferred
      )
    }
    saveRegistry(migrated)
    return migrated
  }

  private func saveRegistry(_ registry: [Submission]) {
    if let data = try? JSONEncoder().encode(registry) {
      defaults.set(data, forKey: Key.registry)
    }
  }

  private func markSubmission(_ identifier: String, state: Submission.State) {
    var registry = loadRegistry()
    guard let index = registry.lastIndex(where: { $0.identifier == identifier }) else { return }
    let now = Date().timeIntervalSince1970
    registry[index].state = state
    registry[index].lifecycleUpdatedAt = now
    if state == .attached { registry[index].attachedAt = now }
    if state == .deferralRequested { registry[index].deferralRequestedAt = now }
    if state == .deferred { registry[index].deferredAt = now }
    if state == .complete { registry[index].completedAt = now }
    pruneRegistry(&registry)
    saveRegistry(registry)
  }

  private func pruneRegistry(_ registry: inout [Submission]) {
    let now = Date().timeIntervalSince1970
    let originals = Dictionary(uniqueKeysWithValues: registry.map { ($0.identifier, $0) })
    let retained = MainaIOSContinuedProcessingRetentionPolicy.prune(registry.map {
      MainaIOSContinuedProcessingRetentionPolicy.Record(
        identifier: $0.identifier,
        state: .init(rawValue: $0.state.rawValue) ?? .deferred,
        createdAt: $0.createdAt,
        updatedAt: $0.completedAt ?? $0.deferredAt ?? $0.lifecycleUpdatedAt
      )
    }, now: now)
    registry = retained.compactMap { record in
      guard var submission = originals[record.identifier] else { return nil }
      submission.state = .init(rawValue: record.state.rawValue) ?? .deferred
      if submission.state == .deferred && submission.deferredAt == nil {
        submission.deferredAt = record.updatedAt
        submission.lifecycleUpdatedAt = record.updatedAt
      }
      return submission
    }
  }

  private func beginFallbackTask(identifier: String) {
    guard fallbackTasks[identifier] == nil else { return }
    var task = UIBackgroundTaskIdentifier.invalid
    let start = {
      task = UIApplication.shared.beginBackgroundTask(withName: "Maina transcription") { [weak self] in
        self?.expireFallbackTaskSynchronously(identifier: identifier)
      }
    }
    if Thread.isMainThread { start() } else { DispatchQueue.main.sync(execute: start) }
    if task != .invalid { fallbackTasks[identifier] = task }
  }

  private func expireFallbackTaskSynchronously(identifier: String) {
    let task: UIBackgroundTaskIdentifier = queue.sync {
      let value = fallbackTasks.removeValue(forKey: identifier) ?? .invalid
      markSubmission(identifier, state: .deferred)
      return value
    }
    if task != .invalid { UIApplication.shared.endBackgroundTask(task) }
  }

  private func endFallbackTask(identifier: String) {
    guard let task = fallbackTasks.removeValue(forKey: identifier), task != .invalid else { return }
    let end = { UIApplication.shared.endBackgroundTask(task) }
    if Thread.isMainThread { end() } else { DispatchQueue.main.async(execute: end) }
  }
}
