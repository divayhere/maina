import Foundation

@main
enum MainaIOSPipelineWakePolicyTests {
  static func main() {
    let generationN = 8
    let generationNPlusOne = 9
    let due = Int64(1_777_777_777_000)

    precondition(
      MainaIOSPipelineWakePolicy.scheduleAction(
        active: true,
        activeGeneration: generationN,
        requestedGeneration: generationN,
        requestedRevision: 4,
        requestedNotBeforeAt: due,
        pendingRequestExists: false,
        storedGeneration: generationN,
        storedRevision: 4,
        storedNotBeforeAt: due
      ) == .activeOwnsGeneration
    )
    precondition(
      MainaIOSPipelineWakePolicy.scheduleAction(
        active: true,
        activeGeneration: generationN,
        requestedGeneration: generationNPlusOne,
        requestedRevision: 5,
        requestedNotBeforeAt: due,
        pendingRequestExists: false,
        storedGeneration: generationN,
        storedRevision: 4,
        storedNotBeforeAt: due
      ) == .submitPendingRequest
    )
    precondition(
      MainaIOSPipelineWakePolicy.scheduleAction(
        active: false,
        activeGeneration: 0,
        requestedGeneration: generationNPlusOne,
        requestedRevision: 5,
        requestedNotBeforeAt: due - 60_000,
        pendingRequestExists: true,
        storedGeneration: generationNPlusOne,
        storedRevision: 5,
        storedNotBeforeAt: due
      ) == .replacePendingRequest
    )
    precondition(
      MainaIOSPipelineWakePolicy.scheduleAction(
        active: false,
        activeGeneration: 0,
        requestedGeneration: generationNPlusOne,
        requestedRevision: 5,
        requestedNotBeforeAt: due + 60_000,
        pendingRequestExists: true,
        storedGeneration: generationNPlusOne,
        storedRevision: 5,
        storedNotBeforeAt: due
      ) == .keepPendingRequest
    )

    precondition(
      MainaIOSPipelineWakePolicy.shouldResetLegacyScheduler(
        storedProtocolVersion: 1,
        requestedProtocolVersion: 2,
        hasUnfinishedSQLiteWork: true,
        active: false
      )
    )
    precondition(
      !MainaIOSPipelineWakePolicy.shouldResetLegacyScheduler(
        storedProtocolVersion: 2,
        requestedProtocolVersion: 2,
        hasUnfinishedSQLiteWork: true,
        active: false
      )
    )
    precondition(
      !MainaIOSPipelineWakePolicy.shouldResetLegacyScheduler(
        storedProtocolVersion: 1,
        requestedProtocolVersion: 2,
        hasUnfinishedSQLiteWork: true,
        active: true
      )
    )

    precondition(
      MainaIOSPipelineWakePolicy.storedTupleMatchesPreviousOrCurrent(
        storedGeneration: generationN,
        storedRevision: 4,
        storedNotBeforeAt: due,
        requestedGeneration: generationN,
        requestedRevision: 5,
        requestedNotBeforeAt: due - 60_000,
        previousRevision: 4,
        previousNotBeforeAt: due
      )
    )
    precondition(
      MainaIOSPipelineWakePolicy.storedTupleMatchesPreviousOrCurrent(
        storedGeneration: generationN,
        storedRevision: 5,
        storedNotBeforeAt: due - 60_000,
        requestedGeneration: generationN,
        requestedRevision: 5,
        requestedNotBeforeAt: due - 60_000,
        previousRevision: 4,
        previousNotBeforeAt: due
      )
    )
    precondition(
      !MainaIOSPipelineWakePolicy.storedTupleMatchesPreviousOrCurrent(
        storedGeneration: generationN,
        storedRevision: 99,
        storedNotBeforeAt: due,
        requestedGeneration: generationN,
        requestedRevision: 5,
        requestedNotBeforeAt: due - 60_000,
        previousRevision: 4,
        previousNotBeforeAt: due
      )
    )

    precondition(
      MainaIOSPipelineWakePolicy.retainedGenerationAfterCompletion(
        completedGeneration: generationN,
        requestedGeneration: generationNPlusOne,
        succeeded: true
      ) == generationNPlusOne
    )
    precondition(
      MainaIOSPipelineWakePolicy.retainedGenerationAfterCompletion(
        completedGeneration: generationN,
        requestedGeneration: generationN,
        succeeded: true
      ) == 0
    )
    precondition(
      MainaIOSPipelineWakePolicy.retainedGenerationAfterCompletion(
        completedGeneration: generationN,
        requestedGeneration: generationN,
        succeeded: false
      ) == generationN
    )
  }
}
