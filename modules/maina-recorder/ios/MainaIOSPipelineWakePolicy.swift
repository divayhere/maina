import Foundation

enum MainaIOSPipelineWakeScheduleAction: Equatable {
  case activeOwnsGeneration
  case keepPendingRequest
  case replacePendingRequest
  case submitPendingRequest
}

/**
 * Pure ownership decisions for the single static BGProcessing identifier.
 * SQLite remains the durable queue; this policy only decides whether the one
 * native request already represents the exact generation/revision/due tuple.
 */
enum MainaIOSPipelineWakePolicy {
  static let schedulerProtocolVersion = 2

  static func shouldResetLegacyScheduler(
    storedProtocolVersion: Int,
    requestedProtocolVersion: Int,
    hasUnfinishedSQLiteWork: Bool,
    active: Bool
  ) -> Bool {
    requestedProtocolVersion == schedulerProtocolVersion
      && storedProtocolVersion < schedulerProtocolVersion
      && hasUnfinishedSQLiteWork
      && !active
  }

  static func scheduleAction(
    active: Bool,
    activeGeneration: Int,
    requestedGeneration: Int,
    requestedRevision: Int,
    requestedNotBeforeAt: Int64,
    pendingRequestExists: Bool,
    storedGeneration: Int,
    storedRevision: Int,
    storedNotBeforeAt: Int64
  ) -> MainaIOSPipelineWakeScheduleAction {
    if active && requestedGeneration <= activeGeneration {
      return .activeOwnsGeneration
    }
    guard pendingRequestExists else { return .submitPendingRequest }
    if storedGeneration != requestedGeneration || storedRevision != requestedRevision {
      return .replacePendingRequest
    }
    if requestedNotBeforeAt < storedNotBeforeAt {
      return .replacePendingRequest
    }
    return .keepPendingRequest
  }

  static func storedTupleMatchesPreviousOrCurrent(
    storedGeneration: Int,
    storedRevision: Int,
    storedNotBeforeAt: Int64,
    requestedGeneration: Int,
    requestedRevision: Int,
    requestedNotBeforeAt: Int64,
    previousRevision: Int?,
    previousNotBeforeAt: Int64?
  ) -> Bool {
    let matchesCurrent = storedGeneration == requestedGeneration
      && storedRevision == requestedRevision
      && storedNotBeforeAt == requestedNotBeforeAt
    let matchesPrevious = previousRevision != nil
      && previousNotBeforeAt != nil
      && storedGeneration == requestedGeneration
      && storedRevision == previousRevision
      && storedNotBeforeAt == previousNotBeforeAt
    return matchesCurrent || matchesPrevious
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
}
