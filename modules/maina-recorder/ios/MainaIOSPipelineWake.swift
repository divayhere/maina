import BackgroundTasks
import Foundation

/**
 * Scheduling-only bridge for Maina's single durable SQLite pipeline outbox.
 * The native layer never owns cloud payloads, retry policy, or a second queue;
 * it only keeps one network-constrained BGProcessing request and hands its
 * bounded execution token to the shared TypeScript drain.
 */
public final class MainaIOSPipelineWake {
  public static let shared = MainaIOSPipelineWake()
  public static let taskIdentifier = "com.divay.maina.staging.pipeline-network"

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

  /** Register the static identifier before launch completion. */
  public static func registerLaunchHandler() {
    shared.queue.sync {
      guard !shared.registered else { return }
      shared.registered = BGTaskScheduler.shared.register(
        forTaskWithIdentifier: taskIdentifier,
        using: shared.queue
      ) { [weak shared] task in
        shared?.handle(task)
      }
      // A process cannot still own a previous BGTask object. Keep the durable
      // generation but clear the stale native token; startup JS/periodic repair
      // observes the SQLite enqueue-required row and resubmits if needed.
      shared.defaults.removeObject(forKey: Key.activeToken)
      shared.defaults.set("registered", forKey: Key.scheduleState)
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
    completion: @escaping ([String: Any]) -> Void
  ) {
    queue.async {
      let priorGeneration = self.defaults.integer(forKey: Key.generation)
      let requestedGeneration = max(generation, priorGeneration)
      if generation > priorGeneration {
        // A genuine new durable signal may reopen bounded scheduling after an
        // older generation exhausted native submissions.
        self.defaults.set(0, forKey: Key.scheduleAttempts)
      }
      self.defaults.set(requestedGeneration, forKey: Key.generation)
      self.defaults.set(requiresNetwork, forKey: Key.requiresNetwork)

      let scheduleAction = MainaIOSPipelineWakePolicy.scheduleAction(
        active: self.activeGate?.isActive == true,
        activeGeneration: self.activeGeneration,
        requestedGeneration: requestedGeneration
      )
      if scheduleAction == .activeOwnsGeneration {
        self.defaults.set("running", forKey: Key.scheduleState)
        completion(["scheduled": true, "workId": Self.taskIdentifier])
        return
      }
      guard self.registered else {
        self.defaults.set("unavailable", forKey: Key.scheduleState)
        completion(["scheduled": false, "errorCode": "ios_bg_handler_unregistered"])
        return
      }

      BGTaskScheduler.shared.getPendingTaskRequests { requests in
        self.queue.async {
          let pendingRequestExists = requests.contains(where: {
            $0.identifier == Self.taskIdentifier
          })
          if !MainaIOSPipelineWakePolicy.shouldSubmitPendingRequest(
            action: scheduleAction,
            pendingRequestExists: pendingRequestExists
          ) {
            self.defaults.set("pending", forKey: Key.scheduleState)
            completion(["scheduled": true, "workId": Self.taskIdentifier])
            return
          }
          self.submitPendingRequest(completion: completion)
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

  private func submitPendingRequest(completion: @escaping ([String: Any]) -> Void) {
    let attempts = defaults.integer(forKey: Key.scheduleAttempts)
    guard attempts < maxNativeScheduleAttempts else {
      defaults.set("max_attempts", forKey: Key.scheduleState)
      completion(["scheduled": false, "errorCode": "ios_bg_schedule_attempts_exhausted"])
      return
    }
    let request = BGProcessingTaskRequest(identifier: Self.taskIdentifier)
    request.requiresNetworkConnectivity = defaults.bool(forKey: Key.requiresNetwork)
    request.requiresExternalPower = false
    request.earliestBeginDate = Date()
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
    // One static request means there can be only one active native attempt.
    // Fail a duplicate delivery closed rather than creating parallel drains.
    guard activeGate == nil else {
      task.setTaskCompleted(success: false)
      return
    }
    let gate = CompletionGate(task: task)
    let token = UUID().uuidString
    activeGate = gate
    activeToken = token
    activeGeneration = defaults.integer(forKey: Key.generation)
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
    // RN may fail to initialize after a background launch. Never leak the OS
    // assertion: complete false exactly once and retain the durable generation.
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
    }
  }

  private func scheduleRetryAfterCurrentTask() {
    let generation = defaults.integer(forKey: Key.generation)
    guard generation > 0 else { return }
    queue.asyncAfter(deadline: .now() + .seconds(1)) {
      self.schedule(
        generation: generation,
        requiresNetwork: self.defaults.bool(forKey: Key.requiresNetwork)
      ) { _ in }
    }
  }
}
