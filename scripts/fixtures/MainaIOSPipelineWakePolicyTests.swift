import Foundation

@main
enum MainaIOSPipelineWakePolicyTests {
  static func main() {
    let generationN = 8
    let generationNPlusOne = 9

    precondition(
      MainaIOSPipelineWakePolicy.scheduleAction(
        active: true,
        activeGeneration: generationN,
        requestedGeneration: generationN
      ) == .activeOwnsGeneration
    )

    let successorAction = MainaIOSPipelineWakePolicy.scheduleAction(
      active: true,
      activeGeneration: generationN,
      requestedGeneration: generationNPlusOne
    )
    precondition(successorAction == .ensurePendingRequest)

    // MainaIOSPipelineWake queries the one static identifier before submit.
    // Repeated N+1 repairs therefore retain exactly one actual pending request.
    var pendingRequestExists = false
    var submittedRequests = 0
    for _ in 0..<2 where successorAction == .ensurePendingRequest {
      if MainaIOSPipelineWakePolicy.shouldSubmitPendingRequest(
        action: successorAction,
        pendingRequestExists: pendingRequestExists
      ) {
        pendingRequestExists = true
        submittedRequests += 1
      }
    }
    precondition(submittedRequests == 1)

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
