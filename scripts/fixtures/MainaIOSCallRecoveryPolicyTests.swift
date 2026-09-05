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

print("iOS call-recovery policy tests passed.")
  }
}
