enum MainaIOSNativeCaptureTerminalPolicy {
  enum CompletionAction: String {
    case ignore
    case validateAudio = "validate_audio"
    case recoveryRequired = "recovery_required"
  }

  static func nextTerminalGeneration(after current: Int) -> Int? {
    guard current >= 0, current < Int.max else { return nil }
    return current + 1
  }

  static func completionAction(
    pendingGeneration: Int?,
    completionGeneration: Int,
    recorderIdentityMatches: Bool,
    stateIsFinalizing: Bool,
    signal: String
  ) -> CompletionAction {
    guard let pendingGeneration,
      pendingGeneration > 0,
      completionGeneration == pendingGeneration,
      recorderIdentityMatches,
      stateIsFinalizing
    else { return .ignore }
    switch signal {
    case "recorder_succeeded":
      return .validateAudio
    case "recorder_failed", "encode_error", "timeout":
      return .recoveryRequired
    default:
      return .ignore
    }
  }

  static func isCleanStop(
    meetingId: String?,
    generation: Int,
    stoppedState: String,
    closeOutcome: String,
    finalizationErrorPresent: Bool,
    segmentCount: Int,
    payloadBytes: Int64,
    terminalEvidenceComplete: Bool
  ) -> Bool {
    guard meetingId?.isEmpty == false,
      generation > 0,
      !finalizationErrorPresent,
      segmentCount > 0,
      payloadBytes > 0,
      terminalEvidenceComplete
    else { return false }
    return (stoppedState == "recording" && closeOutcome == "finalized")
      || (stoppedState == "paused" && closeOutcome == "no_active")
  }
}
