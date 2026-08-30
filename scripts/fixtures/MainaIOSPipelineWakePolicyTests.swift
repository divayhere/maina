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

    let current = MainaIOSPipelineWakeTarget(
      generation: generationN,
      requiresNetwork: true,
      notBeforeAt: due,
      scheduleRevision: 4
    )
    let successor = MainaIOSPipelineWakeTarget(
      generation: generationNPlusOne,
      requiresNetwork: true,
      notBeforeAt: due + 120_000,
      scheduleRevision: 5
    )
    precondition(
      MainaIOSPipelineWakePolicy.shouldDeferBehindActive(
        active: true,
        activeGeneration: generationN,
        requestedGeneration: generationNPlusOne
      )
    )
    precondition(
      MainaIOSPipelineWakePolicy.retainedTargetsAfterCompletion(
        completedGeneration: generationN,
        succeeded: true,
        current: current,
        deferred: successor
      ) == MainaIOSPipelineWakeRetention(current: successor, deferred: nil)
    )
    precondition(
      MainaIOSPipelineWakePolicy.retainedTargetsAfterCompletion(
        completedGeneration: generationN,
        succeeded: false,
        current: current,
        deferred: successor
      ) == MainaIOSPipelineWakeRetention(current: current, deferred: successor)
    )

    // More than five sequential targets each receive an independent bounded
    // budget, while repeated submissions of one exact tuple do not reset it.
    var attemptGeneration = 0
    var attemptRevision = 0
    var attempts = 0
    for generation in 1...7 {
      if MainaIOSPipelineWakePolicy.shouldResetAttemptBudget(
        attemptedGeneration: attemptGeneration,
        attemptedRevision: attemptRevision,
        acceptedGeneration: generation,
        acceptedRevision: generation
      ) {
        attempts = 0
        attemptGeneration = generation
        attemptRevision = generation
      }
      attempts += 1
      precondition(attempts == 1)
    }
    for expectedAttempt in 2...5 {
      precondition(
        !MainaIOSPipelineWakePolicy.shouldResetAttemptBudget(
          attemptedGeneration: attemptGeneration,
          attemptedRevision: attemptRevision,
          acceptedGeneration: attemptGeneration,
          acceptedRevision: attemptRevision
        )
      )
      attempts += 1
      precondition(attempts == expectedAttempt)
    }
    precondition(
      MainaIOSPipelineWakePolicy.shouldResetAttemptBudget(
        attemptedGeneration: attemptGeneration,
        attemptedRevision: attemptRevision,
        acceptedGeneration: attemptGeneration,
        acceptedRevision: attemptRevision + 1
      )
    )
    attempts = 0
    attemptRevision += 1
    attempts += 1
    precondition(attempts == 1)

    // Once the accepted successor records protocol v2, relaunch must not
    // repeat the legacy reset.
    precondition(
      !MainaIOSPipelineWakePolicy.shouldResetLegacyScheduler(
        storedProtocolVersion: 2,
        requestedProtocolVersion: 2,
        hasUnfinishedSQLiteWork: true,
        active: false
      )
    )
  }
}
