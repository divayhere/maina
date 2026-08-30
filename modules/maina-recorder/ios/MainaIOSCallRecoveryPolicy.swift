import Foundation

enum MainaIOSCallRecoveryPolicy {
  enum Action: Equatable {
    case start
    case coalesce
    case vetoManualPause
    case vetoCommunication
    case ignoreInactive
  }

  static func action(
    paused: Bool,
    interrupted: Bool,
    manuallyPaused: Bool,
    communicationActive: Bool,
    observerCallActive: Bool,
    recoveryLoopActive: Bool
  ) -> Action {
    guard paused, interrupted else { return .ignoreInactive }
    if manuallyPaused { return .vetoManualPause }
    if communicationActive || observerCallActive { return .vetoCommunication }
    if recoveryLoopActive { return .coalesce }
    return .start
  }

  static func manualResumeAllowed(
    communicationActive: Bool,
    observerCallActive: Bool
  ) -> Bool {
    !communicationActive && !observerCallActive
  }
}
