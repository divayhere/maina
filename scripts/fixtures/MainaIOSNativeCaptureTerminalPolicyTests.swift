import Foundation

private func require(_ condition: @autoclosure () -> Bool, _ message: String) {
  if !condition() {
    FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
    exit(1)
  }
}

@main
enum MainaIOSNativeCaptureTerminalPolicyTests {
  static func main() {
    require(MainaIOSNativeCaptureTerminalPolicy.nextTerminalGeneration(after: 0) == 1,
      "the first explicit terminal operation must receive generation one")
    require(MainaIOSNativeCaptureTerminalPolicy.nextTerminalGeneration(after: 41) == 42,
      "terminal generations must advance independently and monotonically")
    require(MainaIOSNativeCaptureTerminalPolicy.nextTerminalGeneration(after: -1) == nil,
      "a negative terminal counter must fail closed")
    require(MainaIOSNativeCaptureTerminalPolicy.nextTerminalGeneration(after: Int.max) == nil,
      "terminal generation overflow must fail closed")
    require(MainaIOSNativeCaptureTerminalPolicy.completionAction(
      pendingGeneration: 7,
      completionGeneration: 7,
      recorderIdentityMatches: true,
      stateIsFinalizing: true,
      signal: "recorder_succeeded"
    ) == .validateAudio, "a matching successful recorder callback must advance to audio validation")
    var unrelatedCallRecoveryGeneration = 41
    let terminalGeneration = 7
    unrelatedCallRecoveryGeneration += 1
    require(unrelatedCallRecoveryGeneration == 42, "the call recovery test setup must advance independently")
    require(MainaIOSNativeCaptureTerminalPolicy.completionAction(
      pendingGeneration: terminalGeneration,
      completionGeneration: terminalGeneration,
      recorderIdentityMatches: true,
      stateIsFinalizing: true,
      signal: "recorder_succeeded"
    ) == .validateAudio, "call reentry must not invalidate the independent terminal callback")
    require(MainaIOSNativeCaptureTerminalPolicy.completionAction(
      pendingGeneration: terminalGeneration,
      completionGeneration: terminalGeneration,
      recorderIdentityMatches: true,
      stateIsFinalizing: true,
      signal: "timeout"
    ) == .recoveryRequired, "call reentry must not invalidate the independent terminal timeout")
    for signal in ["recorder_failed", "encode_error", "timeout"] {
      require(MainaIOSNativeCaptureTerminalPolicy.completionAction(
        pendingGeneration: 7,
        completionGeneration: 7,
        recorderIdentityMatches: true,
        stateIsFinalizing: true,
        signal: signal
      ) == .recoveryRequired, "\(signal) must require recovery")
    }
    let staleCallbacks: [(String, Int?, Int, Bool, Bool)] = [
      ("missing pending stop", nil, 7, true, true),
      ("wrong recorder", 7, 7, false, true),
      ("stale generation", 8, 7, true, true),
      ("no longer finalizing", 7, 7, true, false),
    ]
    for (name, pendingGeneration, completionGeneration, identityMatches, finalizing) in staleCallbacks {
      require(MainaIOSNativeCaptureTerminalPolicy.completionAction(
        pendingGeneration: pendingGeneration,
        completionGeneration: completionGeneration,
        recorderIdentityMatches: identityMatches,
        stateIsFinalizing: finalizing,
        signal: "recorder_succeeded"
      ) == .ignore, "\(name) must ignore a stale recorder callback")
    }
    require(MainaIOSNativeCaptureTerminalPolicy.completionAction(
      pendingGeneration: 7,
      completionGeneration: 7,
      recorderIdentityMatches: true,
      stateIsFinalizing: true,
      signal: "unknown"
    ) == .ignore, "unknown callback signals must fail closed without gaining authority")

    let cleanRecording = MainaIOSNativeCaptureTerminalPolicy.isCleanStop(
      meetingId: "meeting-1", generation: 7, stoppedState: "recording",
      closeOutcome: "finalized", finalizationErrorPresent: false,
      segmentCount: 2, payloadBytes: 32_768, terminalEvidenceComplete: true
    )
    require(cleanRecording, "a clean recording stop must publish exact terminal success")
    require(MainaIOSNativeCaptureTerminalPolicy.isCleanStop(
      meetingId: "meeting-1", generation: 8, stoppedState: "paused",
      closeOutcome: "no_active", finalizationErrorPresent: false,
      segmentCount: 1, payloadBytes: 16_384, terminalEvidenceComplete: true
    ), "a deliberate paused stop may use its already-finalized readable segment")

    let rejected: [(String, Bool)] = [
      ("missing meeting", MainaIOSNativeCaptureTerminalPolicy.isCleanStop(
        meetingId: nil, generation: 7, stoppedState: "recording", closeOutcome: "finalized",
        finalizationErrorPresent: false, segmentCount: 1, payloadBytes: 1, terminalEvidenceComplete: true)),
      ("invalid generation", MainaIOSNativeCaptureTerminalPolicy.isCleanStop(
        meetingId: "meeting-1", generation: 0, stoppedState: "recording", closeOutcome: "finalized",
        finalizationErrorPresent: false, segmentCount: 1, payloadBytes: 1, terminalEvidenceComplete: true)),
      ("move conflict", MainaIOSNativeCaptureTerminalPolicy.isCleanStop(
        meetingId: "meeting-1", generation: 7, stoppedState: "recording", closeOutcome: "failed",
        finalizationErrorPresent: true, segmentCount: 1, payloadBytes: 1, terminalEvidenceComplete: true)),
      ("unreadable audio", MainaIOSNativeCaptureTerminalPolicy.isCleanStop(
        meetingId: "meeting-1", generation: 7, stoppedState: "recording", closeOutcome: "finalized",
        finalizationErrorPresent: false, segmentCount: 1, payloadBytes: 1, terminalEvidenceComplete: false)),
      ("zero frames", MainaIOSNativeCaptureTerminalPolicy.isCleanStop(
        meetingId: "meeting-1", generation: 7, stoppedState: "recording", closeOutcome: "finalized",
        finalizationErrorPresent: false, segmentCount: 0, payloadBytes: 0, terminalEvidenceComplete: true)),
      ("active recorder missing", MainaIOSNativeCaptureTerminalPolicy.isCleanStop(
        meetingId: "meeting-1", generation: 7, stoppedState: "recording", closeOutcome: "no_active",
        finalizationErrorPresent: false, segmentCount: 1, payloadBytes: 1, terminalEvidenceComplete: true)),
      ("paused recorder unexpectedly finalized", MainaIOSNativeCaptureTerminalPolicy.isCleanStop(
        meetingId: "meeting-1", generation: 7, stoppedState: "paused", closeOutcome: "finalized",
        finalizationErrorPresent: false, segmentCount: 1, payloadBytes: 1, terminalEvidenceComplete: true)),
      ("abort disposition shape", MainaIOSNativeCaptureTerminalPolicy.isCleanStop(
        meetingId: "meeting-1", generation: 7, stoppedState: "finalizing", closeOutcome: "discarded",
        finalizationErrorPresent: false, segmentCount: 1, payloadBytes: 1, terminalEvidenceComplete: true)),
    ]
    for (name, accepted) in rejected { require(!accepted, "\(name) must fail closed") }

    let callbackCount = 4 + 1 + 2 + 3 + staleCallbacks.count + 1
    print("iOS native capture terminal policy tests passed: \(callbackCount + 2 + rejected.count)/\(callbackCount + 2 + rejected.count)")
  }
}
