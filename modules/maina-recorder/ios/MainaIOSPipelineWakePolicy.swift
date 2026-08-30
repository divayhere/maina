import Foundation

enum MainaIOSPipelineWakeScheduleAction: Equatable {
  case activeOwnsGeneration
  case keepPendingRequest
  case replacePendingRequest
  case submitPendingRequest
}

struct MainaIOSPipelineWakeTarget: Equatable {
  let generation: Int
  let requiresNetwork: Bool
  let notBeforeAt: Int64
  let scheduleRevision: Int
}

struct MainaIOSPipelineWakeRetention: Equatable {
  let current: MainaIOSPipelineWakeTarget?
  let deferred: MainaIOSPipelineWakeTarget?
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

  static func shouldResetAttemptBudget(
    attemptedGeneration: Int,
    attemptedRevision: Int,
    acceptedGeneration: Int,
    acceptedRevision: Int
  ) -> Bool {
    attemptedGeneration != acceptedGeneration || attemptedRevision != acceptedRevision
  }

  static func shouldDeferBehindActive(
    active: Bool,
    activeGeneration: Int,
    requestedGeneration: Int
  ) -> Bool {
    active && requestedGeneration > activeGeneration
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


  static func retainedTargetsAfterCompletion(
    completedGeneration: Int,
    succeeded: Bool,
    current: MainaIOSPipelineWakeTarget?,
    deferred: MainaIOSPipelineWakeTarget?
  ) -> MainaIOSPipelineWakeRetention {
    if !succeeded {
      return MainaIOSPipelineWakeRetention(current: current, deferred: deferred)
    }
    if let deferred, deferred.generation > completedGeneration {
      return MainaIOSPipelineWakeRetention(current: deferred, deferred: nil)
    }
    if let current, current.generation > completedGeneration {
      return MainaIOSPipelineWakeRetention(current: current, deferred: nil)
    }
    return MainaIOSPipelineWakeRetention(current: nil, deferred: nil)
  }
}
