import Foundation

private func require(_ condition: @autoclosure () -> Bool, _ message: String) {
  if !condition() {
    FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
    exit(1)
  }
}

@main
enum MainaIOSCallRecoveryPolicyTests {
  static func main() {
require(MainaIOSCallRecoveryPolicy.action(
  paused: true, interrupted: true, manuallyPaused: false,
  communicationActive: true, observerCallActive: false, recoveryLoopActive: false
) == .vetoCommunication, "an active call must veto recovery")
require(MainaIOSCallRecoveryPolicy.action(
  paused: true, interrupted: true, manuallyPaused: true,
  communicationActive: false, observerCallActive: false, recoveryLoopActive: false
) == .vetoManualPause, "manual pause must never auto-resume")
require(MainaIOSCallRecoveryPolicy.action(
  paused: true, interrupted: true, manuallyPaused: false,
  communicationActive: false, observerCallActive: false, recoveryLoopActive: true
) == .coalesce, "duplicate end/route signals must coalesce")
require(MainaIOSCallRecoveryPolicy.action(
  paused: true, interrupted: true, manuallyPaused: false,
  communicationActive: false, observerCallActive: false, recoveryLoopActive: false
) == .start, "the first post-call signal must start one watcher")
require(!MainaIOSCallRecoveryPolicy.manualResumeAllowed(
  communicationActive: false, observerCallActive: true
), "manual resume cannot override an observer-owned call")

let staleCommunicationActive = true
let rejectedCallRefresh = MainaIOSCallRecoveryPolicy.refreshedCommunicationActive(
  cached: staleCommunicationActive,
  observerCallActive: false
)
require(staleCommunicationActive, "the fixture must begin with stale active-call state")
require(!rejectedCallRefresh, "an ended/rejected call must clear stale cached call state")
require(MainaIOSCallRecoveryPolicy.action(
  paused: true, interrupted: true, manuallyPaused: false,
  communicationActive: rejectedCallRefresh,
  observerCallActive: false, recoveryLoopActive: false
) == .start, "clearing stale call state must start unattended recovery")
require(MainaIOSCallRecoveryPolicy.manualResumeAllowed(
  communicationActive: rejectedCallRefresh,
  observerCallActive: false
), "clearing stale call state must also release the manual recovery veto")

let newlyObservedCall = MainaIOSCallRecoveryPolicy.refreshedCommunicationActive(
  cached: false,
  observerCallActive: true
)
require(newlyObservedCall, "a currently observed call must still veto recovery")

require(
  MainaIOSCallRecoveryPolicy.manualResumeAction(
    interrupted: true,
    deliberatelyPaused: false,
    communicationActive: true,
    observerCallActive: true
  ) == .queueSystemRecovery,
  "Resume during a system pause must queue one recovery even while the call remains active"
)
require(
  MainaIOSCallRecoveryPolicy.manualResumeAction(
    interrupted: true,
    deliberatelyPaused: true,
    communicationActive: true,
    observerCallActive: true
  ) == .rejectCommunicationActive,
  "a deliberate pause must not be converted into automatic system recovery"
)
require(
  MainaIOSCallRecoveryPolicy.manualResumeAction(
    interrupted: false,
    deliberatelyPaused: true,
    communicationActive: false,
    observerCallActive: false
  ) == .resumeDeliberatePause,
  "a deliberate pause resumes only through the ordinary manual path"
)

require(
  MainaIOSCallRecoveryPolicy.failureDisposition(
    domain: NSOSStatusErrorDomain,
    code: 560_557_684
  ) == .temporaryPlatformHold,
  "cannotInterruptOthers must remain a temporary platform hold"
)
require(
  MainaIOSCallRecoveryPolicy.failureDisposition(
    domain: NSOSStatusErrorDomain,
    code: 560_557_685
  ) == .other,
  "a neighboring OSStatus must not be classified as cannotInterruptOthers"
)
require(
  MainaIOSCallRecoveryPolicy.failureDisposition(
    domain: "OtherDomain",
    code: 560_557_684
  ) == .other,
  "the platform hold classification must bind both domain and code"
)
require(
  MainaIOSCallRecoveryPolicy.shouldRetainPendingGeneration(
    disposition: .temporaryPlatformHold,
    stopped: false,
    manuallyPaused: false
  ),
  "a live system pause must retain one pending recovery generation"
)
require(
  !MainaIOSCallRecoveryPolicy.shouldRetainPendingGeneration(
    disposition: .temporaryPlatformHold,
    stopped: true,
    manuallyPaused: false
  ),
  "Stop or save must revoke a pending platform hold"
)
require(
  !MainaIOSCallRecoveryPolicy.shouldRetainPendingGeneration(
    disposition: .temporaryPlatformHold,
    stopped: false,
    manuallyPaused: true
  ),
  "deliberate manual pause must revoke automatic recovery"
)
require(
  MainaIOSCallRecoveryPolicy.recoveryMayRetry(elapsedMs: 29_999, budgetMs: 30_000),
  "the live recovery watcher may retry inside its bounded window"
)
require(
  !MainaIOSCallRecoveryPolicy.recoveryMayRetry(elapsedMs: 30_000, budgetMs: 30_000),
  "the live recovery watcher must stop at its exact budget"
)
require(
  !MainaIOSCallRecoveryPolicy.recoveryMayRetry(elapsedMs: -1, budgetMs: 30_000),
  "invalid elapsed time must fail closed"
)

let longCallEndedAt: TimeInterval = 120
let firstPostCallLoop = MainaIOSCallRecoveryPolicy.recoveryLoopStart(
  existing: nil,
  action: .start,
  attempt: 0,
  now: longCallEndedAt
)
require(firstPostCallLoop == longCallEndedAt, "a long call must receive a fresh post-call recovery budget")
require(
  MainaIOSCallRecoveryPolicy.recoveryMayRetry(
    elapsedMs: (120.001 - (firstPostCallLoop ?? 0)) * 1_000,
    budgetMs: 30_000
  ),
  "call duration must not consume the post-call recovery budget"
)
let recursiveLoop = MainaIOSCallRecoveryPolicy.recoveryLoopStart(
  existing: firstPostCallLoop,
  action: .start,
  attempt: 4,
  now: 126
)
require(recursiveLoop == firstPostCallLoop, "recursive attempts must preserve one loop clock")
let coalescedLoop = MainaIOSCallRecoveryPolicy.recoveryLoopStart(
  existing: firstPostCallLoop,
  action: .coalesce,
  attempt: 0,
  now: 127
)
require(coalescedLoop == firstPostCallLoop, "duplicate public signals must not reset the active loop")
let laterPublicSignalLoop = MainaIOSCallRecoveryPolicy.recoveryLoopStart(
  existing: nil,
  action: .start,
  attempt: 0,
  now: 240
)
require(laterPublicSignalLoop == 240, "a later real public signal must start a fresh bounded loop")
require(laterPublicSignalLoop != firstPostCallLoop, "separate public-signal loops must not share stale timing")

print("iOS call-recovery policy tests passed.")
  }
}
