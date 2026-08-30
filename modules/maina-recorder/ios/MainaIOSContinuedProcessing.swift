import BackgroundTasks
import CryptoKit
import Foundation
import UIKit

/**
 * Monitors one user-started local-ASR run without becoming its data owner.
 * Each scheduler submission has a never-reused identifier; durable per-window
 * SQLite claims remain the source of truth when iOS expires or relaunches work.
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
    enum State: String, Codable { case pending, attached, deferred, complete }
    let identifier: String
    let meetingId: String
    let createdAt: TimeInterval
    var state: State
    var completedAt: TimeInterval?
  }

  private enum Key {
    static let registry = "maina.continuedProcessing.registry.v2"
    static let sequence = "maina.continuedProcessing.sequence.v2"
  }

  private let queue = DispatchQueue(label: "com.divay.maina.ios.continued-processing")
  private let requestIdentifierPrefix = "com.divay.maina.staging.continued-processing.transcription"
  private let defaults = UserDefaults.standard
  private var registeredIdentifiers = Set<String>()
  private var gates: [String: CompletionGate] = [:]
  private var claimedIdentifiers = Set<String>()
  private var currentIdentifier: String?
  private var fallbackTask = UIBackgroundTaskIdentifier.invalid
  private var fallbackMeetingId: String?
  private var completedUnits: Int64 = 0
  private var totalUnits: Int64 = 1

  private init() {}

  /** Re-register exact pending identifiers before RN starts after relaunch. */
  public static func registerLaunchHandler() {
    guard #available(iOS 26.0, *) else { return }
    shared.queue.sync {
      var registry = shared.loadRegistry()
      shared.pruneRegistry(&registry)
      shared.saveRegistry(registry)
      for submission in registry where submission.state == .pending || submission.state == .attached {
        _ = shared.registerExactIdentifierIfNeeded(submission.identifier)
      }
    }
  }

  func begin(jobId: String, title: String, subtitle: String, totalUnits: Int) -> [String: Any] {
    queue.sync {
      completedUnits = 0
      self.totalUnits = Int64(max(1, totalUnits))
      // Apple continued-processing submissions are foreground, user-initiated
      // assertions. A BGProcessing recovery may run the same durable ASR work,
      // but it must never manufacture a new continued-processing request.
      guard UIApplication.shared.applicationState == .active else {
        return [
          "started": false,
          "mode": "existing-background-owner",
          "reason": "continued-processing-requires-foreground",
        ]
      }
      if #available(iOS 26.0, *) {
        var registry = loadRegistry()
        pruneRegistry(&registry)

        // A background delivery may attach before RN starts. Claim that exact
        // persisted submission instead of creating a duplicate request.
        if let existing = registry.last(where: {
          $0.meetingId == jobId && ($0.state == .pending || $0.state == .attached)
        }) {
          currentIdentifier = existing.identifier
          claimedIdentifiers.insert(existing.identifier)
          saveRegistry(registry)
          beginFallbackTask(meetingId: jobId)
          return [
            "started": true,
            "mode": gates[existing.identifier]?.isActive == true ? "attached-existing" : "pending-existing",
            "requestId": existing.identifier,
          ]
        }

        let requestIdentifier = makeUniqueIdentifier(meetingId: jobId)
        registry.append(Submission(
          identifier: requestIdentifier,
          meetingId: jobId,
          createdAt: Date().timeIntervalSince1970,
          state: .pending,
          completedAt: nil
        ))
        saveRegistry(registry) // Persist before registration/submission.
        guard registerExactIdentifierIfNeeded(requestIdentifier) else {
          markSubmission(requestIdentifier, state: .deferred)
          beginFallbackTask(meetingId: jobId)
          return [
            "started": fallbackTask != .invalid,
            "mode": "fallback",
            "reason": "continued-processing-handler-unregistered",
            "requestId": requestIdentifier,
          ]
        }
        currentIdentifier = requestIdentifier
        claimedIdentifiers.insert(requestIdentifier)
        let request = BGContinuedProcessingTaskRequest(
          identifier: requestIdentifier,
          title: title,
          subtitle: subtitle
        )
        // The engine begins now from this foreground user action. `.fail`
        // makes a delayed/refused monitor observable rather than silently
        // queueing another execution owner.
        request.strategy = .fail
        do {
          try BGTaskScheduler.shared.submit(request)
          beginFallbackTask(meetingId: jobId)
          return [
            "started": true,
            "mode": "continued-processing-requested",
            "requestId": requestIdentifier,
          ]
        } catch {
          markSubmission(requestIdentifier, state: .deferred)
          beginFallbackTask(meetingId: jobId)
          return [
            "started": fallbackTask != .invalid,
            "mode": "fallback",
            "reason": "continued-processing-submit-\((error as NSError).code)",
            "requestId": requestIdentifier,
          ]
        }
      }
      currentIdentifier = nil
      beginFallbackTask(meetingId: jobId)
      return ["started": fallbackTask != .invalid, "mode": "fallback"]
    }
  }

  func update(completedUnits: Int, totalUnits: Int, subtitle: String?) {
    queue.async {
      self.completedUnits = Int64(max(0, completedUnits))
      self.totalUnits = Int64(max(1, totalUnits))
      guard #available(iOS 26.0, *),
        let identifier = self.currentIdentifier,
        let task = self.gates[identifier],
        task.isActive
      else { return }
      // BGTask itself is retained in CompletionGate; progress is obtained from
      // the handler's concrete task while attached.
      self.updateAttachedProgress(identifier: identifier, subtitle: subtitle)
    }
  }

  func finish(success: Bool) {
    queue.async {
      if let identifier = self.currentIdentifier {
        if let gate = self.gates[identifier] {
          _ = gate.complete(success: success)
          self.gates.removeValue(forKey: identifier)
        } else {
          BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
        }
        self.claimedIdentifiers.remove(identifier)
        self.markSubmission(identifier, state: success ? .complete : .deferred)
        self.currentIdentifier = nil
      }
      self.endFallbackTask()
    }
  }

  func isActive(meetingId: String) -> Bool {
    queue.sync {
      if UIApplication.shared.applicationState == .active { return true }
      if fallbackTask != .invalid && fallbackMeetingId == meetingId { return true }
      guard let submission = loadRegistry().last(where: {
        $0.meetingId == meetingId && ($0.state == .pending || $0.state == .attached)
      }) else { return false }
      return gates[submission.identifier]?.isActive == true
    }
  }

  @available(iOS 26.0, *)
  private func registerExactIdentifierIfNeeded(_ identifier: String) -> Bool {
    if registeredIdentifiers.contains(identifier) { return true }
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
    guard gates[identifier] == nil else {
      task.setTaskCompleted(success: false)
      return
    }
    let gate = CompletionGate(task: task)
    gates[identifier] = gate
    currentIdentifier = identifier
    markSubmission(identifier, state: .attached)
    endFallbackTask()
    task.expirationHandler = { [weak self, weak gate] in
      guard let self, let gate else { return }
      self.queue.async {
        guard self.gates[identifier] === gate else { return }
        _ = gate.complete(success: false)
        self.gates.removeValue(forKey: identifier)
        self.claimedIdentifiers.remove(identifier)
        self.markSubmission(identifier, state: .deferred)
        if self.currentIdentifier == identifier { self.currentIdentifier = nil }
        self.endFallbackTask()
      }
    }
    if #available(iOS 26.0, *), let continued = task as? BGContinuedProcessingTask {
      continued.progress.totalUnitCount = totalUnits
      continued.progress.completedUnitCount = min(completedUnits, totalUnits)
    }

    // A delivered task may relaunch before JS. If the same meeting does not
    // claim it through begin(...) within ten seconds, complete false exactly
    // once and leave the submission deferred for the durable recovery path.
    queue.asyncAfter(deadline: .now() + .seconds(10)) { [weak self, weak gate] in
      guard let self, let gate,
        self.gates[identifier] === gate,
        !self.claimedIdentifiers.contains(identifier)
      else { return }
      _ = gate.complete(success: false)
      self.gates.removeValue(forKey: identifier)
      self.markSubmission(identifier, state: .deferred)
      if self.currentIdentifier == identifier { self.currentIdentifier = nil }
    }
  }

  private func updateAttachedProgress(identifier: String, subtitle: String?) {
    // This lookup is intentionally limited to the current handler. The task
    // may already have expired; CompletionGate.isActive fences late updates.
    guard let gate = gates[identifier], gate.isActive else { return }
    if #available(iOS 26.0, *) {
      gate.updateProgress(completedUnits: completedUnits, total: totalUnits, subtitle: subtitle)
    }
  }

  private func makeUniqueIdentifier(meetingId: String) -> String {
    let digest = SHA256.hash(data: Data(meetingId.utf8)).prefix(8)
      .map { String(format: "%02x", $0) }.joined()
    let sequence = defaults.integer(forKey: Key.sequence) + 1
    defaults.set(sequence, forKey: Key.sequence)
    let nonce = UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(8).lowercased()
    return "\(requestIdentifierPrefix).\(digest).\(sequence).\(nonce)"
  }

  private func loadRegistry() -> [Submission] {
    guard let data = defaults.data(forKey: Key.registry),
      let value = try? JSONDecoder().decode([Submission].self, from: data)
    else { return [] }
    return value
  }

  private func saveRegistry(_ registry: [Submission]) {
    if let data = try? JSONEncoder().encode(registry) {
      defaults.set(data, forKey: Key.registry)
    }
  }

  private func markSubmission(_ identifier: String, state: Submission.State) {
    var registry = loadRegistry()
    guard let index = registry.lastIndex(where: { $0.identifier == identifier }) else { return }
    registry[index].state = state
    registry[index].completedAt = state == .complete || state == .deferred
      ? Date().timeIntervalSince1970
      : nil
    pruneRegistry(&registry)
    saveRegistry(registry)
  }

  private func pruneRegistry(_ registry: inout [Submission]) {
    let now = Date().timeIntervalSince1970
    registry = registry.filter {
      switch $0.state {
      case .pending, .attached:
        return now - $0.createdAt < 24 * 60 * 60
      case .deferred, .complete:
        return now - ($0.completedAt ?? $0.createdAt) < 7 * 24 * 60 * 60
      }
    }
    if registry.count > 32 { registry = Array(registry.suffix(32)) }
  }

  private func beginFallbackTask(meetingId: String) {
    guard fallbackTask == .invalid else { return }
    fallbackMeetingId = meetingId
    let start = {
      self.fallbackTask = UIApplication.shared.beginBackgroundTask(withName: "Maina transcription") { [weak self] in
        self?.expireFallbackTaskSynchronously()
      }
    }
    if Thread.isMainThread { start() } else { DispatchQueue.main.sync(execute: start) }
  }

  /** UIKit requires the task to be ended before its expiration handler returns. */
  private func expireFallbackTaskSynchronously() {
    let identifier: UIBackgroundTaskIdentifier = queue.sync {
      let task = fallbackTask
      fallbackTask = .invalid
      fallbackMeetingId = nil
      if let currentIdentifier {
        markSubmission(currentIdentifier, state: .deferred)
      }
      return task
    }
    if identifier != .invalid { UIApplication.shared.endBackgroundTask(identifier) }
  }

  private func endFallbackTask() {
    guard fallbackTask != .invalid else { return }
    let identifier = fallbackTask
    fallbackTask = .invalid
    fallbackMeetingId = nil
    let end = { UIApplication.shared.endBackgroundTask(identifier) }
    if Thread.isMainThread { end() } else { DispatchQueue.main.async(execute: end) }
  }
}
