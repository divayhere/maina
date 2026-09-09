import Foundation

private var passed = 0

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
  guard condition() else {
    FileHandle.standardError.write(Data("FAILED: \(message)\n".utf8))
    exit(1)
  }
}

private func testTransitions() {
  expect(MainaModelPackLifecyclePolicy.transitionAllowed(
    from: "downloading", to: "verifying", guard: "all_declared_bytes_present"
  ), "verified download may enter verification")
  expect(MainaModelPackLifecyclePolicy.transitionAllowed(
    from: "failed_verification", to: "downloading", guard: "same_manifest_invalid_bytes_removed"
  ), "failed verification may retry only after invalid bytes are removed")
  expect(!MainaModelPackLifecyclePolicy.transitionAllowed(
    from: "downloading", to: "ready", guard: "all_declared_bytes_present"
  ), "download cannot skip verification and smoke")
  passed += 1
}

private func testResumePrefix() {
  let declared = [String(repeating: "a", count: 64), String(repeating: "b", count: 64)]
  expect(MainaModelPackLifecyclePolicy.resumePrefix(
    storedManifest: String(repeating: "1", count: 64),
    requestedManifest: String(repeating: "1", count: 64),
    storedPath: "encoder.int8.onnx", requestedPath: "encoder.int8.onnx",
    storedBytes: 20, requestedBytes: 20,
    storedPlatform: "ios", requestedPlatform: "ios",
    storedChunks: [declared[0]], requestedChunks: [declared[0]], declaredChunks: declared
  ) == 1, "exact verified prefix resumes")
  expect(MainaModelPackLifecyclePolicy.resumePrefix(
    storedManifest: String(repeating: "1", count: 64),
    requestedManifest: String(repeating: "2", count: 64),
    storedPath: "encoder.int8.onnx", requestedPath: "encoder.int8.onnx",
    storedBytes: 20, requestedBytes: 20,
    storedPlatform: "ios", requestedPlatform: "ios",
    storedChunks: [declared[0]], requestedChunks: [declared[0]], declaredChunks: declared
  ) == nil, "manifest drift rejects resume")
  expect(MainaModelPackLifecyclePolicy.resumePrefix(
    storedManifest: String(repeating: "1", count: 64),
    requestedManifest: String(repeating: "1", count: 64),
    storedPath: "encoder.int8.onnx", requestedPath: "encoder.int8.onnx",
    storedBytes: 20, requestedBytes: 20,
    storedPlatform: "ios", requestedPlatform: "ios",
    storedChunks: [String(repeating: "9", count: 64)],
    requestedChunks: [String(repeating: "9", count: 64)], declaredChunks: declared
  ) == nil, "non-prefix chunk evidence rejects resume")
  passed += 1
}

private func testStorageFormula() {
  expect(MainaModelPackLifecyclePolicy.requiredSpace(
    newPackBytes: 100, partialOverheadBytes: 10, retainedRollbackBytes: 100, safetyMarginBytes: 10
  ) == 220, "storage includes pack, partial, rollback, and margin")
  expect(MainaModelPackLifecyclePolicy.requiredSpace(
    newPackBytes: UInt64.max, partialOverheadBytes: 1, retainedRollbackBytes: 0, safetyMarginBytes: 0
  ) == nil, "storage overflow fails closed")
  passed += 1
}

private func testPromotion() {
  expect(MainaModelPackLifecyclePolicy.promotionAllowed(
    manifestVerified: true, platformCompatible: true, smokePassed: true,
    previousReadyRetained: true, conflictingWriter: false, stagedDurable: true
  ), "all promotion prerequisites permit activation")
  expect(!MainaModelPackLifecyclePolicy.promotionAllowed(
    manifestVerified: true, platformCompatible: true, smokePassed: false,
    previousReadyRetained: true, conflictingWriter: false, stagedDurable: true
  ), "smoke failure blocks activation")
  expect(!MainaModelPackLifecyclePolicy.promotionAllowed(
    manifestVerified: true, platformCompatible: true, smokePassed: true,
    previousReadyRetained: true, conflictingWriter: true, stagedDurable: true
  ), "conflicting writer blocks activation")
  passed += 1
}

private func testCleanup() {
  expect(MainaModelPackLifecyclePolicy.cleanupAllowed(
    targetActive: false, rollbackRetained: false, inProgress: false,
    pinnedReaders: 0, resultReferences: 0, exactSuccessorResult: true
  ), "unreferenced superseded pack may be cleaned")
  expect(!MainaModelPackLifecyclePolicy.cleanupAllowed(
    targetActive: false, rollbackRetained: false, inProgress: false,
    pinnedReaders: 1, resultReferences: 0, exactSuccessorResult: true
  ), "reader pin blocks cleanup")
  expect(!MainaModelPackLifecyclePolicy.cleanupAllowed(
    targetActive: false, rollbackRetained: false, inProgress: false,
    pinnedReaders: 0, resultReferences: 1, exactSuccessorResult: true
  ), "result reference blocks cleanup")
  expect(!MainaModelPackLifecyclePolicy.cleanupAllowed(
    targetActive: false, rollbackRetained: false, inProgress: false,
    pinnedReaders: 0, resultReferences: 0, exactSuccessorResult: false
  ), "missing exact successor result blocks cleanup")
  passed += 1
}

private func testInterruptedPromotionRecovery() {
  expect(MainaModelPackLifecyclePolicy.interruptedPromotionAction(
    recordState: "ready", readyPointsToWriter: true, previousPointerValid: true
  ) == "complete_success_cleanup", "durable success only clears the stale writer")
  expect(MainaModelPackLifecyclePolicy.interruptedPromotionAction(
    recordState: "smoke_testing", readyPointsToWriter: true, previousPointerValid: true
  ) == "rollback_to_previous", "partial pointer publication restores exact previous ready")
  expect(MainaModelPackLifecyclePolicy.interruptedPromotionAction(
    recordState: "smoke_testing", readyPointsToWriter: true, previousPointerValid: false
  ) == "invalidate_first_activation", "partial first activation is invalidated")
  expect(MainaModelPackLifecyclePolicy.interruptedPromotionAction(
    recordState: "smoke_testing", readyPointsToWriter: false, previousPointerValid: true
  ) == "mark_failed_preserve_current", "pre-pointer crash preserves the current ready pack")
  passed += 1
}

@main
private struct MainaIOSModelPackLifecycleTests {
  static func main() {
    testTransitions()
    testResumePrefix()
    testStorageFormula()
    testPromotion()
    testCleanup()
    testInterruptedPromotionRecovery()
    print("Maina iOS model-pack lifecycle policy tests passed: \(passed)/6")
  }
}
