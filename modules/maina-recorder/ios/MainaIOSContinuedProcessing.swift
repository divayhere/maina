import BackgroundTasks
import Foundation
import UIKit

/**
 * Keeps one user-initiated local transcription visible to iOS as continued
 * processing. iOS 26 receives the system-native task; older systems receive a
 * short UIApplication background grace period and rely on durable per-window
 * checkpoints plus BGProcessing for eventual continuation.
 */
public final class MainaIOSContinuedProcessing {
  public static let shared = MainaIOSContinuedProcessing()

  private let queue = DispatchQueue(label: "com.divay.maina.ios.continued-processing")
  private let wildcardIdentifier = "com.divay.maina.staging.continued-processing.*"
  private let requestIdentifier = "com.divay.maina.staging.continued-processing.transcription"
  private var registered = false
  private var activeTask: BGTask?
  private var fallbackTask = UIBackgroundTaskIdentifier.invalid
  private var completedUnits: Int64 = 0
  private var totalUnits: Int64 = 1

  private init() {}

  /**
   * Register the iOS continued-processing launch handler during the native app
   * launch sequence, before React Native starts. A pending task can relaunch
   * Maina before JavaScript exists; registering from the Expo module's first
   * method call is therefore too late and iOS terminates the process.
   */
  public static func registerLaunchHandler() {
    guard #available(iOS 26.0, *) else { return }
    shared.queue.sync {
      shared.registerIfNeeded()
    }
  }

  func begin(title: String, subtitle: String, totalUnits: Int) -> [String: Any] {
    queue.sync {
      self.completedUnits = 0
      self.totalUnits = Int64(max(1, totalUnits))
      if #available(iOS 26.0, *) {
        // Never attempt a late registration after app launch. If the generated
        // native entry point is misconfigured, preserve the meeting with the
        // ordinary background grace period and durable checkpoint worker.
        guard registered else {
          beginFallbackTask()
          return ["started": fallbackTask != .invalid, "mode": "fallback", "reason": "continued-processing-handler-unregistered"]
        }
        let request = BGContinuedProcessingTaskRequest(
          identifier: requestIdentifier,
          title: title,
          subtitle: subtitle
        )
        request.strategy = .queue
        do {
          try BGTaskScheduler.shared.submit(request)
          return ["started": true, "mode": "continued-processing"]
        } catch {
          // A submission refusal must not lose a meeting. Checkpoints and the
          // scheduled processing worker remain the durable fallback.
          beginFallbackTask()
          return ["started": fallbackTask != .invalid, "mode": "fallback", "reason": error.localizedDescription]
        }
      }
      beginFallbackTask()
      return ["started": fallbackTask != .invalid, "mode": "fallback"]
    }
  }

  func update(completedUnits: Int, totalUnits: Int, subtitle: String?) {
    queue.async {
      self.completedUnits = Int64(max(0, completedUnits))
      self.totalUnits = Int64(max(1, totalUnits))
      guard #available(iOS 26.0, *), let task = self.activeTask as? BGContinuedProcessingTask else { return }
      task.progress.totalUnitCount = self.totalUnits
      task.progress.completedUnitCount = min(self.completedUnits, self.totalUnits)
      if let subtitle, !subtitle.isEmpty {
        task.updateTitle("Preparing meeting transcript", subtitle: subtitle)
      }
    }
  }

  func finish(success: Bool) {
    queue.async {
      if let task = self.activeTask {
        task.setTaskCompleted(success: success)
        self.activeTask = nil
      }
      self.endFallbackTask()
    }
  }

  @available(iOS 26.0, *)
  private func registerIfNeeded() {
    guard !registered else { return }
    registered = BGTaskScheduler.shared.register(
      forTaskWithIdentifier: wildcardIdentifier,
      using: queue
    ) { [weak self] task in
      self?.attach(task)
    }
  }

  private func attach(_ task: BGTask) {
    activeTask = task
    task.expirationHandler = { [weak self, weak task] in
      self?.queue.async {
        task?.setTaskCompleted(success: false)
        self?.activeTask = nil
      }
    }
    if #available(iOS 26.0, *), let continued = task as? BGContinuedProcessingTask {
      continued.progress.totalUnitCount = totalUnits
      continued.progress.completedUnitCount = min(completedUnits, totalUnits)
    }
  }

  private func beginFallbackTask() {
    guard fallbackTask == .invalid else { return }
    let start = {
      self.fallbackTask = UIApplication.shared.beginBackgroundTask(withName: "Maina transcription") { [weak self] in
        self?.queue.async { self?.endFallbackTask() }
      }
    }
    if Thread.isMainThread { start() } else { DispatchQueue.main.sync(execute: start) }
  }

  private func endFallbackTask() {
    guard fallbackTask != .invalid else { return }
    let identifier = fallbackTask
    fallbackTask = .invalid
    let end = { UIApplication.shared.endBackgroundTask(identifier) }
    if Thread.isMainThread { end() } else { DispatchQueue.main.async(execute: end) }
  }
}
