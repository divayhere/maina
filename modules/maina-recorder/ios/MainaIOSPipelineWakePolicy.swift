import Foundation

enum MainaIOSPipelineWakeScheduleAction: Equatable {
  case activeOwnsGeneration
  case ensurePendingRequest
}

/**
 * Pure ownership decisions for the single static BGProcessing identifier.
 * Keeping this separate makes the N -> N+1 handoff testable without faking
 * BGTask objects or introducing a second native queue.
 */
enum MainaIOSPipelineWakePolicy {
  static func scheduleAction(
    active: Bool,
    activeGeneration: Int,
    requestedGeneration: Int
  ) -> MainaIOSPipelineWakeScheduleAction {
    if active && requestedGeneration <= activeGeneration {
      return .activeOwnsGeneration
    }
    return .ensurePendingRequest
  }

  static func retainedGenerationAfterCompletion(
    completedGeneration: Int,
    requestedGeneration: Int,
    succeeded: Bool
  ) -> Int {
    if succeeded && requestedGeneration <= completedGeneration {
      return 0
    }
    return requestedGeneration
  }

  static func shouldSubmitPendingRequest(
    action: MainaIOSPipelineWakeScheduleAction,
    pendingRequestExists: Bool
  ) -> Bool {
    action == .ensurePendingRequest && !pendingRequestExists
  }
}
