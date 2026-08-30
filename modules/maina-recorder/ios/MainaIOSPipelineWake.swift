import BackgroundTasks
import Foundation

/**
 * Scheduling-only bridge for Maina's single durable SQLite pipeline outbox.
 * Native state identifies one BGProcessing request; it never stores payloads,
 * retries cloud contracts itself, or creates a second queue.
 */
public final class MainaIOSPipelineWake {
  public static let shared = MainaIOSPipelineWake()
  public static let taskIdentifier = "com.divay.maina.staging.pipeline-network"

  private struct ScheduleTarget {
    let generation: Int
    let requiresNetwork: Bool
    let notBeforeAt: Int64
    let scheduleRevision: Int
  }

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
  }

  private enum Key {
    static let generation = "maina.pipelineWake.generation"
    static let requiresNetwork = "maina.pipelineWake.requiresNetwork"
    static let notBeforeAt = "maina.pipelineWake.notBeforeAt"
    static let scheduleRevision = "maina.pipelineWake.scheduleRevision"
    static let schedulerProtocolVersion = "maina.pipelineWake.schedulerProtocolVersion"
    static let scheduleAttempts = "maina.pipelineWake.scheduleAttempts"
    static let scheduleState = "maina.pipelineWake.scheduleState"
    static let activeToken = "maina.pipelineWake.activeToken"
  }

  private let queue = DispatchQueue(label: "com.divay.maina.ios.pipeline-wake")
  private let defaults = UserDefaults.standard
  private var registered = false
  private var activeGate: CompletionGate?
  private var activeToken: String?
  private var activeGeneration = 0
  private var jsClaimed = false
  private var onWakeRequested: (([String: Any]) -> Void)?
  private let maxNativeScheduleAttempts = 5

  private init() {}

  /** Register the one static network identifier before launch completion. */
  public static func registerLaunchHandler() {
    shared.queue.sync {
      guard !shared.registered else { return }
      shared.registered = BGTaskScheduler.shared.register(
        forTaskWithIdentifier: taskIdentifier,
        using: shared.queue
      ) { [weak shared] task in
        shared?.handle(task)
      }
      // A new process cannot own the prior process's BGTask object. The exact
      // SQLite generation remains durable and will explicitly repair schedule.
      shared.defaults.removeObject(forKey: Key.activeToken)
      if shared.defaults.integer(forKey: Key.generation) == 0 {
        shared.defaults.set("registered", forKey: Key.scheduleState)
      }
    }
  }

  func configure(onWakeRequested: @escaping ([String: Any]) -> Void) {
    queue.async {
      self.onWakeRequested = onWakeRequested
      self.emitWakeIfNeeded()
    }
  }

  func schedule(
    generation: Int,
    requiresNetwork: Bool,
    notBeforeAt: Int64,
    scheduleRevision: Int,
    previousWorkId: String?,
    previousNotBeforeAt: Int64?,
    previousScheduleRevision: Int?,
    schedulerProtocolVersion: Int,
    completion: @escaping ([String: Any]) -> Void
  ) {
    queue.async {
      guard generation > 0, scheduleRevision >= 0 else {
        completion(["scheduled": false, "errorCode": "invalid_generation_or_revision"])
        return
      }
      guard schedulerProtocolVersion == MainaIOSPipelineWakePolicy.schedulerProtocolVersion else {
        completion(["scheduled": false, "errorCode": "unsupported_scheduler_protocol"])
        return
      }
      if let previousWorkId, previousWorkId != Self.taskIdentifier {
        completion(["scheduled": false, "errorCode": "previous_work_identity_mismatch"])
        return
      }
      guard self.registered else {
        self.defaults.set("unavailable", forKey: Key.scheduleState)
        completion(["scheduled": false, "errorCode": "ios_bg_handler_unregistered"])
        return
      }

      let storedProtocol = self.defaults.integer(forKey: Key.schedulerProtocolVersion)
      let active = self.activeGate?.isActive == true
      let resetLegacy = MainaIOSPipelineWakePolicy.shouldResetLegacyScheduler(
        storedProtocolVersion: storedProtocol,
        requestedProtocolVersion: schedulerProtocolVersion,
        hasUnfinishedSQLiteWork: generation > 0,
        active: active
      )
      if storedProtocol < schedulerProtocolVersion && !resetLegacy {
        completion(["scheduled": false, "errorCode": "scheduler_protocol_upgrade_deferred"])
        return
      }

      let storedBefore = self.storedTarget()
      if !resetLegacy, storedProtocol == schedulerProtocolVersion, previousWorkId != nil {
        guard let storedBefore,
          MainaIOSPipelineWakePolicy.storedTupleMatchesPreviousOrCurrent(
            storedGeneration: storedBefore.generation,
            storedRevision: storedBefore.scheduleRevision,
            storedNotBeforeAt: storedBefore.notBeforeAt,
            requestedGeneration: generation,
            requestedRevision: scheduleRevision,
            requestedNotBeforeAt: notBeforeAt,
            previousRevision: previousScheduleRevision,
            previousNotBeforeAt: previousNotBeforeAt
          )
        else {
          completion(["scheduled": false, "errorCode": "previous_schedule_tuple_mismatch"])
          return
        }
      }
      if resetLegacy {
        // The bridge call is the explicit proof of unfinished SQLite work.
        // Cancel only the pending static request; active BGTasks are fenced out.
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.taskIdentifier)
        self.defaults.set(0, forKey: Key.scheduleAttempts)
        self.defaults.set(schedulerProtocolVersion, forKey: Key.schedulerProtocolVersion)
      }

      let target = ScheduleTarget(
        generation: generation,
        requiresNetwork: requiresNetwork,
        notBeforeAt: max(0, notBeforeAt),
        scheduleRevision: scheduleRevision
      )
      if active && generation <= self.activeGeneration {
        // A same-generation update may carry the retry due that must be armed
        // after this active task completes. No second active owner is created.
        self.persist(target)
        self.defaults.set("running", forKey: Key.scheduleState)
        completion(["scheduled": true, "workId": Self.taskIdentifier])
        return
      }

      BGTaskScheduler.shared.getPendingTaskRequests { requests in
        self.queue.async {
          let pendingRequestExists = requests.contains(where: {
            $0.identifier == Self.taskIdentifier
          })
          let action = MainaIOSPipelineWakePolicy.scheduleAction(
            active: self.activeGate?.isActive == true,
            activeGeneration: self.activeGeneration,
            requestedGeneration: target.generation,
            requestedRevision: target.scheduleRevision,
            requestedNotBeforeAt: target.notBeforeAt,
            pendingRequestExists: pendingRequestExists,
            storedGeneration: storedBefore?.generation ?? 0,
            storedRevision: storedBefore?.scheduleRevision ?? -1,
            storedNotBeforeAt: storedBefore?.notBeforeAt ?? Int64.max
          )
          switch action {
          case .activeOwnsGeneration:
            self.persist(target)
            self.defaults.set("running", forKey: Key.scheduleState)
            completion(["scheduled": true, "workId": Self.taskIdentifier])
          case .keepPendingRequest:
            self.defaults.set("pending", forKey: Key.scheduleState)
            completion(["scheduled": true, "workId": Self.taskIdentifier])
          case .replacePendingRequest:
            // This API cancels a pending request only. The CompletionGate is
            // the independent fence proving no active BGTask is touched.
            BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.taskIdentifier)
            self.persist(target)
            self.submitPendingRequest(target, completion: completion)
          case .submitPendingRequest:
            self.persist(target)
            self.submitPendingRequest(target, completion: completion)
          }
        }
      }
    }
  }

  func claimPending() -> [String: Any]? {
    queue.sync {
      guard let activeToken,
        activeGate?.isActive == true,
        !jsClaimed
      else { return nil }
      jsClaimed = true
      defaults.set("claimed", forKey: Key.scheduleState)
      return [
        "attemptToken": activeToken,
        "wakeKind": "shared",
        "generation": activeGeneration,
      ]
    }
  }

  func isActive(attemptToken: String) -> Bool {
    queue.sync {
      self.activeToken == attemptToken && self.activeGate?.isActive == true
    }
  }

  func hasActiveExecution() -> Bool {
    queue.sync { activeGate?.isActive == true }
  }

  func complete(attemptToken: String, succeeded: Bool) -> Bool {
    queue.sync {
      guard activeToken == attemptToken, let gate = activeGate else { return false }
      let completedGeneration = activeGeneration
      let completed = gate.complete(success: succeeded)
      guard completed else { return false }
      clearActiveState(success: succeeded, completedGeneration: completedGeneration)
      if !succeeded { scheduleRetryAfterCurrentTask() }
      return true
    }
  }

  private func storedTarget() -> ScheduleTarget? {
    let generation = defaults.integer(forKey: Key.generation)
    guard generation > 0 else { return nil }
    return ScheduleTarget(
      generation: generation,
      requiresNetwork: defaults.bool(forKey: Key.requiresNetwork),
      notBeforeAt: Int64(defaults.integer(forKey: Key.notBeforeAt)),
      scheduleRevision: defaults.integer(forKey: Key.scheduleRevision)
    )
  }

  private func persist(_ target: ScheduleTarget) {
    defaults.set(target.generation, forKey: Key.generation)
    defaults.set(target.requiresNetwork, forKey: Key.requiresNetwork)
    defaults.set(target.notBeforeAt, forKey: Key.notBeforeAt)
    defaults.set(target.scheduleRevision, forKey: Key.scheduleRevision)
    defaults.set(
      MainaIOSPipelineWakePolicy.schedulerProtocolVersion,
      forKey: Key.schedulerProtocolVersion
    )
  }

  private func submitPendingRequest(
    _ target: ScheduleTarget,
    completion: @escaping ([String: Any]) -> Void
  ) {
    let attempts = defaults.integer(forKey: Key.scheduleAttempts)
    guard attempts < maxNativeScheduleAttempts else {
      defaults.set("max_attempts", forKey: Key.scheduleState)
      completion(["scheduled": false, "errorCode": "ios_bg_schedule_attempts_exhausted"])
      return
    }
    let request = BGProcessingTaskRequest(identifier: Self.taskIdentifier)
    request.requiresNetworkConnectivity = target.requiresNetwork
    request.requiresExternalPower = false
    request.earliestBeginDate = Date(
      timeIntervalSince1970: TimeInterval(target.notBeforeAt) / 1_000
    )
    defaults.set(attempts + 1, forKey: Key.scheduleAttempts)
    do {
      try BGTaskScheduler.shared.submit(request)
      defaults.set("pending", forKey: Key.scheduleState)
      completion(["scheduled": true, "workId": Self.taskIdentifier])
    } catch {
      defaults.set("enqueue_failed", forKey: Key.scheduleState)
      completion([
        "scheduled": false,
        "errorCode": "ios_bg_enqueue_\((error as NSError).code)",
      ])
    }
  }

  private func handle(_ task: BGTask) {
    guard task is BGProcessingTask else {
      task.setTaskCompleted(success: false)
      return
    }
    guard activeGate == nil, let target = storedTarget() else {
      task.setTaskCompleted(success: false)
      return
    }
    let gate = CompletionGate(task: task)
    let token = UUID().uuidString
    activeGate = gate
    activeToken = token
    activeGeneration = target.generation
    jsClaimed = false
    defaults.set(token, forKey: Key.activeToken)
    defaults.set("running", forKey: Key.scheduleState)

    task.expirationHandler = { [weak self, weak gate] in
      guard let self, let gate else { return }
      self.queue.async {
        guard self.activeGate === gate else { return }
        let completedGeneration = self.activeGeneration
        _ = gate.complete(success: false)
        self.clearActiveState(success: false, completedGeneration: completedGeneration)
        self.scheduleRetryAfterCurrentTask()
      }
    }

    emitWakeIfNeeded()
    queue.asyncAfter(deadline: .now() + .seconds(10)) { [weak self, weak gate] in
      guard let self, let gate,
        self.activeGate === gate,
        !self.jsClaimed
      else { return }
      let completedGeneration = self.activeGeneration
      _ = gate.complete(success: false)
      self.clearActiveState(success: false, completedGeneration: completedGeneration)
      self.scheduleRetryAfterCurrentTask()
    }
  }

  private func emitWakeIfNeeded() {
    guard activeGate?.isActive == true, !jsClaimed else { return }
    onWakeRequested?(["generation": activeGeneration])
  }

  private func clearActiveState(success: Bool, completedGeneration: Int) {
    let requestedGeneration = defaults.integer(forKey: Key.generation)
    let retainedGeneration = MainaIOSPipelineWakePolicy.retainedGenerationAfterCompletion(
      completedGeneration: completedGeneration,
      requestedGeneration: requestedGeneration,
      succeeded: success
    )
    activeGate = nil
    activeToken = nil
    activeGeneration = 0
    jsClaimed = false
    defaults.removeObject(forKey: Key.activeToken)
    defaults.set(
      success && retainedGeneration == 0 ? "complete" : success ? "pending" : "deferred",
      forKey: Key.scheduleState
    )
    defaults.set(retainedGeneration, forKey: Key.generation)
    if success && retainedGeneration == 0 {
      defaults.set(0, forKey: Key.scheduleAttempts)
      defaults.set(0, forKey: Key.notBeforeAt)
      defaults.set(0, forKey: Key.scheduleRevision)
    }
  }

  private func scheduleRetryAfterCurrentTask() {
    guard let target = storedTarget() else { return }
    queue.asyncAfter(deadline: .now() + .seconds(1)) {
      self.schedule(
        generation: target.generation,
        requiresNetwork: target.requiresNetwork,
        notBeforeAt: target.notBeforeAt,
        scheduleRevision: target.scheduleRevision,
        previousWorkId: nil,
        previousNotBeforeAt: nil,
        previousScheduleRevision: nil,
        schedulerProtocolVersion: MainaIOSPipelineWakePolicy.schedulerProtocolVersion
      ) { _ in }
    }
  }
}
