import Foundation

enum MainaIOSCallRecoveryPolicy {
  static let cannotInterruptOthersDomain = NSOSStatusErrorDomain
  static let cannotInterruptOthersCode = 560_557_684

  enum Action: Equatable {
    case start
    case coalesce
    case vetoManualPause
    case vetoCommunication
    case ignoreInactive
  }

  enum FailureDisposition: Equatable {
    case temporaryPlatformHold
    case other
  }

  enum ManualResumeAction: Equatable {
    case queueSystemRecovery
    case resumeDeliberatePause
    case rejectCommunicationActive
  }

  static func manualResumeAction(
    interrupted: Bool,
    deliberatelyPaused: Bool,
    communicationActive: Bool,
    observerCallActive: Bool
  ) -> ManualResumeAction {
    if interrupted && !deliberatelyPaused { return .queueSystemRecovery }
    return manualResumeAllowed(
      communicationActive: communicationActive,
      observerCallActive: observerCallActive
    ) ? .resumeDeliberatePause : .rejectCommunicationActive
  }

  static func failureDisposition(domain: String, code: Int) -> FailureDisposition {
    domain == cannotInterruptOthersDomain && code == cannotInterruptOthersCode
      ? .temporaryPlatformHold
      : .other
  }

  static func shouldRetainPendingGeneration(
    disposition: FailureDisposition,
    stopped: Bool,
    manuallyPaused: Bool
  ) -> Bool {
    disposition == .temporaryPlatformHold && !stopped && !manuallyPaused
  }

  static func recoveryMayRetry(elapsedMs: Double, budgetMs: Double) -> Bool {
    elapsedMs >= 0 && elapsedMs < budgetMs
  }

  static func recoveryLoopStart(
    existing: TimeInterval?,
    action: Action,
    attempt: Int,
    now: TimeInterval
  ) -> TimeInterval? {
    if attempt > 0 { return existing }
    return action == .start ? now : existing
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

  /**
   * CallKit's current call list is the authoritative recovery-time signal.
   * A cached true value can outlive a rejected/ended call when callback and
   * audio-session notifications arrive in a different order; it must not keep
   * an otherwise recoverable recording paused.
   */
  static func refreshedCommunicationActive(
    cached _: Bool,
    observerCallActive: Bool
  ) -> Bool {
    observerCallActive
  }
}
