import Foundation
import CryptoKit

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

private func testBoundedVersionComparisonDoesNotNarrow() {
  let comparisons: [(String, String, Int)] = [
    ("17", "17", 0),
    ("17.0", "17", 0),
    ("17.0.0", "17.0", 0),
    ("17.0.1", "17.0", 1),
    ("18", "17.99999999999999999999999999999999", 1),
    ("00017.00", "17.0.0", 0),
    ("17", "99999999999999999999999999999999", -1),
    ("17.1", "17.99999999999999999999999999999999", -1),
    ("17.1.1", "17.1.99999999999999999999999999999999", -1),
  ]
  for (left, right, expected) in comparisons {
    expect(MainaModelPackLifecyclePolicy.compareVersions(left, right) == Optional(expected),
      "bounded version comparison must preserve every decimal component")
  }
  expect(MainaModelPackLifecyclePolicy.compareVersions("1.\(String(repeating: "0", count: 62))", "1") == 0,
    "the exact 64-character boundary remains valid")
  for invalid in [
    "", "17.", ".17", "17..0", "17.0.0.0", "-17", "+17", " 17", "17 ", "17\n",
    "１７", "١٧", String(repeating: "9", count: 65),
  ] {
    expect(MainaModelPackLifecyclePolicy.compareVersions("17", invalid) == nil,
      "invalid, Unicode, or oversized version text must fail closed")
  }
  passed += 1
}

private func testManifestScalarAndContainerShapesFailClosed() {
  let mutations: [([String: Any]) -> [String: Any]] = [
    { input in var value = input; value["packVersion"] = 1; return value },
    { input in var value = input; value["files"] = ["0": (input["files"] as! [[String: Any]])[0]]; return value },
    { input in var value = input; value["platforms"] = ["0": (input["platforms"] as! [[String: Any]])[0]]; return value },
    { input in var value = input; value["platforms"] = [NSNull(), (input["platforms"] as! [[String: Any]])[1]]; return value },
    { input in
      var value = input; var platforms = value["platforms"] as! [[String: Any]]
      platforms[0]["minOsVersion"] = 26; value["platforms"] = platforms; return value
    },
    { input in
      var value = input; var platforms = value["platforms"] as! [[String: Any]]
      platforms[0]["architectures"] = [64]; value["platforms"] = platforms; return value
    },
    { input in
      var value = input; var files = value["files"] as! [[String: Any]]
      files[0]["chunkSha256"] = [1]; value["files"] = files; return value
    },
  ]
  for mutation in mutations {
    withTemporaryRoot("manifest-shape") { root in
      var manifest = mutation(syntheticManifest())
      rehashManifest(&manifest)
      expect(manifestBeginFailure(manifest, root: root) == "MANIFEST_INVALID",
        "scalar and container drift must use the closed manifest reason")
      expectNoAcquisitionState(root)
    }
  }
  passed += 1
}

private func testPlatformReasonsAndHostileMinimumFailBeforeAcquisition() {
  let android = platform("android", "26", "arm64-v8a", "sherpa-onnx-1.13.6",
    "0012d9a28f15bd6fb966b62b70a75da3990512fdccce28b83098248ce4be1698", String(repeating: "a", count: 64))
  let ios = platform("ios", "17.0", "arm64", "sherpa-onnx-1.13.4-ios-no-tts",
    "d8baaa925248e8e8ad23870208cdaf3d093623e6733aede2c23862f30c5aac62", String(repeating: "b", count: 64))
  for platforms: [[String: Any]] in [[], [android], [android, android], [android, ios, ios]] {
    withTemporaryRoot("platform-identity") { root in
      var manifest = syntheticManifest()
      manifest["platforms"] = platforms
      rehashManifest(&manifest)
      expect(manifestBeginFailure(manifest, root: root) == "PLATFORM_COMPATIBILITY_MISMATCH",
        "platform cardinality and identity must use the compatibility reason")
      expectNoAcquisitionState(root)
    }
  }

  for platforms in [
    [platform("windows", "17.0", "arm64", "sherpa-onnx-1.13.4-ios-no-tts",
      "d8baaa925248e8e8ad23870208cdaf3d093623e6733aede2c23862f30c5aac62", String(repeating: "b", count: 64)), ios],
    [platform("android", String(repeating: "9", count: 65), "arm64-v8a", "sherpa-onnx-1.13.6",
      "0012d9a28f15bd6fb966b62b70a75da3990512fdccce28b83098248ce4be1698", String(repeating: "a", count: 64)), ios],
  ] {
    withTemporaryRoot("platform-structure") { root in
      var manifest = syntheticManifest()
      manifest["platforms"] = platforms
      rehashManifest(&manifest)
      expect(manifestBeginFailure(manifest, root: root) == "MANIFEST_INVALID",
        "invalid platform fields must use the structural manifest reason")
      expectNoAcquisitionState(root)
    }
  }

  withTemporaryRoot("hostile-minimum") { root in
    var manifest = syntheticManifest()
    var platforms = manifest["platforms"] as! [[String: Any]]
    platforms[1]["minOsVersion"] = String(repeating: "9", count: 32)
    manifest["platforms"] = platforms
    rehashManifest(&manifest)
    expect(manifestBeginFailure(manifest, root: root) == "PLATFORM_COMPATIBILITY_MISMATCH",
      "a correctly hashed unrepresentable minimum must remain incompatible")
    expectNoAcquisitionState(root)
  }
  passed += 1
}

private func testPreRenameCrashUsesStagingAndClearsWriter() {
  withTemporaryRoot("pre-rename") { root in
    let manifest = syntheticManifest()
    let manifestSHA = manifest["manifestSha256"] as! String
    let stage = root.appendingPathComponent("staging/\(manifestSHA)", isDirectory: true)
    try! FileManager.default.createDirectory(at: stage, withIntermediateDirectories: true)
    writeJSON(manifest, to: stage.appendingPathComponent("manifest.json"))
    writeJSON(writer(manifestSHA), to: root.appendingPathComponent("writer.json"))
    writeJSON(writer(manifestSHA), to: root.appendingPathComponent("current.json"))
    writeJSON(record(manifest, state: "smoke_testing", reason: "NONE"), to: root.appendingPathComponent("records/\(manifestSHA).json"))

    let status = try! MainaModelPackLifecycle(root: root).status()
    expect(status.state == "failed_smoke", "pre-rename crash becomes failed_smoke")
    expect(status.reasonCode == "PROMOTION_INTERRUPTED_ROLLED_BACK", "pre-rename crash has bounded reason")
    expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("writer.json").path), "stale writer is cleared")
    expect(FileManager.default.fileExists(atPath: root.appendingPathComponent("current.json").path), "current acquisition remains durable")
    expect(FileManager.default.fileExists(atPath: stage.appendingPathComponent("manifest.json").path), "staging evidence is retained")
  }
  passed += 1
}

private func testStatusExposesAcquisitionAndTerminalFailure() {
  withTemporaryRoot("status") { root in
    let manifest = syntheticManifest()
    let manifestSHA = manifest["manifestSha256"] as! String
    let stage = root.appendingPathComponent("staging/\(manifestSHA)", isDirectory: true)
    try! FileManager.default.createDirectory(at: stage, withIntermediateDirectories: true)
    writeJSON(manifest, to: stage.appendingPathComponent("manifest.json"))
    writeJSON(writer(manifestSHA), to: root.appendingPathComponent("writer.json"))
    writeJSON(writer(manifestSHA), to: root.appendingPathComponent("current.json"))
    let recordURL = root.appendingPathComponent("records/\(manifestSHA).json")
    writeJSON(record(manifest, state: "downloading", reason: "NONE"), to: recordURL)

    let lifecycle = MainaModelPackLifecycle(root: root)
    expect((try! lifecycle.status()).state == "downloading", "status exposes first-install acquisition")

    try! FileManager.default.removeItem(at: root.appendingPathComponent("writer.json"))
    writeJSON(record(manifest, state: "failed_download", reason: "DOWNLOAD_WRITE_FAILED"), to: recordURL)
    let failed = try! MainaModelPackLifecycle(root: root).status()
    expect(failed.state == "failed_download", "status exposes terminal failure after writer cleanup")
    expect(failed.reasonCode == "DOWNLOAD_WRITE_FAILED", "status preserves bounded terminal reason")
  }
  passed += 1
}

private func testResultMappingUsesEngineIdentity() {
  withTemporaryRoot("result") { root in
    let manifest = syntheticManifest()
    let manifestSHA = manifest["manifestSha256"] as! String
    let pack = root.appendingPathComponent("packs/\(manifestSHA)", isDirectory: true)
    try! FileManager.default.createDirectory(at: pack, withIntermediateDirectories: true)
    writeJSON(manifest, to: pack.appendingPathComponent("manifest.json"))
    writeJSON(record(manifest, state: "ready", reason: "NONE", generation: 1), to: root.appendingPathComponent("records/\(manifestSHA).json"))
    writeJSON(pointer(manifest, generation: 1), to: root.appendingPathComponent("ready.json"))
    let lifecycle = MainaModelPackLifecycle(root: root)

    expect(try! lifecycle.noteExactResult(
      modelId: "qwen3-0.6b-int8",
      modelVersion: "synthetic-1",
      runtimeVersion: "sherpa-onnx-1.13.4-ios-no-tts",
      manifestSha256: manifestSHA,
      activationGeneration: 1,
      resultId: "npr_0123456789abcdef0123456789abcdef",
      resultPayloadSha256: String(repeating: "d", count: 64)
    ), "exact result mapping is recorded")
    expect(!(try! lifecycle.noteExactResult(
      modelId: "qwen3-0.6b-int8",
      modelVersion: "synthetic-1",
      runtimeVersion: "sherpa-onnx-1.13.4-ios-no-tts",
      manifestSha256: manifestSHA,
      activationGeneration: 1,
      resultId: "npr_0123456789abcdef0123456789abcdef",
      resultPayloadSha256: String(repeating: "e", count: 64)
    )), "one result identity cannot be rebound to another payload")
    let secondResultId = "npr_11111111111111111111111111111111"
    expect(try! lifecycle.noteExactResult(
      modelId: "qwen3-0.6b-int8",
      modelVersion: "synthetic-1",
      runtimeVersion: "sherpa-onnx-1.13.4-ios-no-tts",
      manifestSha256: manifestSHA,
      activationGeneration: 1,
      resultId: secondResultId,
      resultPayloadSha256: String(repeating: "e", count: 64)
    ), "a second exact result mapping is recorded")
    expect(!(try! lifecycle.noteExactResult(
      modelId: "qwen3-0.6b-int8",
      modelVersion: "synthetic-1",
      runtimeVersion: "sherpa-onnx-1.13.4-ios-no-tts",
      manifestSha256: manifestSHA,
      activationGeneration: 1,
      resultId: secondResultId,
      resultPayloadSha256: String(repeating: "f", count: 64)
    )), "a non-first result identity cannot be rebound to another payload")
    let resultURL = root.appendingPathComponent("results/\(manifestSHA)-1.json")
    let result = try! JSONSerialization.jsonObject(with: Data(contentsOf: resultURL)) as! [String: Any]
    expect(result["modelId"] as? String == "qwen3-0.6b-int8", "result mapping uses engine identity, not pack identity")
    let payloads = result["resultPayloadSha256ById"] as! [String: String]
    expect(payloads[secondResultId] == String(repeating: "e", count: 64),
      "every retained result ID binds its full terminal payload SHA")

    let successor = syntheticManifest(packVersion: "synthetic-1", hashCharacter: "a")
    let successorSHA = successor["manifestSha256"] as! String
    let successorPack = root.appendingPathComponent("packs/\(successorSHA)", isDirectory: true)
    try! FileManager.default.createDirectory(at: successorPack, withIntermediateDirectories: true)
    writeJSON(successor, to: successorPack.appendingPathComponent("manifest.json"))
    writeJSON(record(successor, state: "ready", reason: "NONE", generation: 2), to: root.appendingPathComponent("records/\(successorSHA).json"))
    writeJSON(pointer(successor, generation: 2), to: root.appendingPathComponent("ready.json"))
    writeJSON(writer(successorSHA), to: root.appendingPathComponent("current.json"))
    expect(!(try! lifecycle.noteExactResult(
      modelId: "qwen3-0.6b-int8",
      modelVersion: "synthetic-1",
      runtimeVersion: "sherpa-onnx-1.13.4-ios-no-tts",
      manifestSha256: successorSHA,
      activationGeneration: 2,
      resultId: "npr_abcdef0123456789abcdef0123456789",
      resultPayloadSha256: String(repeating: "f", count: 64)
    )), "one P2 model tuple cannot be rebound to another manifest generation")
  }
  passed += 1
}

private func testLegacyResultMappingMigrationFailsClosed() {
  withTemporaryRoot("legacy-result") { root in
    let manifest = syntheticManifest()
    let manifestSHA = manifest["manifestSha256"] as! String
    let pack = root.appendingPathComponent("packs/\(manifestSHA)", isDirectory: true)
    try! FileManager.default.createDirectory(at: pack, withIntermediateDirectories: true)
    writeJSON(manifest, to: pack.appendingPathComponent("manifest.json"))
    writeJSON(record(manifest, state: "ready", reason: "NONE", generation: 1),
      to: root.appendingPathComponent("records/\(manifestSHA).json"))
    writeJSON(pointer(manifest, generation: 1), to: root.appendingPathComponent("ready.json"))
    let firstResultId = "npr_22222222222222222222222222222222"
    let unverifiedResultId = "npr_33333333333333333333333333333333"
    let recordSHA = sha256(String(data: try! Data(contentsOf: root.appendingPathComponent("records/\(manifestSHA).json")), encoding: .utf8)!)
    let resultURL = root.appendingPathComponent("results/\(manifestSHA)-1.json")
    writeJSON([
      "manifestSha256": manifestSHA,
      "platform": "ios",
      "activationGeneration": 1,
      "modelId": "qwen3-0.6b-int8",
      "modelVersion": "synthetic-1",
      "runtimeVersion": "sherpa-onnx-1.13.4-ios-no-tts",
      "lifecycleRecordSha256": recordSHA,
      "packRetained": true,
      "firstExactResultId": firstResultId,
      "firstExactResultSha256": String(repeating: "d", count: 64),
      "referencedResultIds": [unverifiedResultId, firstResultId],
    ], to: resultURL)

    let lifecycle = MainaModelPackLifecycle(root: root)
    expect(!(try! lifecycle.noteExactResult(
      modelId: "qwen3-0.6b-int8",
      modelVersion: "synthetic-1",
      runtimeVersion: "sherpa-onnx-1.13.4-ios-no-tts",
      manifestSha256: manifestSHA,
      activationGeneration: 1,
      resultId: unverifiedResultId,
      resultPayloadSha256: String(repeating: "e", count: 64)
    )), "legacy non-first references without a retained SHA never become proven")
    let migratedData = try! Data(contentsOf: resultURL)
    let migrated = try! JSONSerialization.jsonObject(with: migratedData) as! [String: Any]
    expect(migrated["schemaVersion"] as? String == "maina.model-pack-result-record.v2",
      "legacy migration publishes an explicit successor schema")
    expect((migrated["resultPayloadSha256ById"] as? [String: String])?[firstResultId]
      == String(repeating: "d", count: 64), "legacy migration preserves the exact first result binding")
    expect(migrated["unverifiedLegacyResultIds"] as? [String] == [unverifiedResultId],
      "legacy migration retains unhashed references only as fail-closed evidence")
    expect(migrated["referencedResultIds"] as? [String] == [firstResultId, unverifiedResultId],
      "legacy migration canonicalizes reference order deterministically")
    expect(!(try! lifecycle.noteExactResult(
      modelId: "qwen3-0.6b-int8",
      modelVersion: "synthetic-1",
      runtimeVersion: "sherpa-onnx-1.13.4-ios-no-tts",
      manifestSha256: manifestSHA,
      activationGeneration: 1,
      resultId: unverifiedResultId,
      resultPayloadSha256: String(repeating: "e", count: 64)
    )), "replay cannot promote an unverified legacy result")
    expect(try! Data(contentsOf: resultURL) == migratedData,
      "rejected legacy promotion does not rewrite durable evidence")
    expect(try! lifecycle.noteExactResult(
      modelId: "qwen3-0.6b-int8",
      modelVersion: "synthetic-1",
      runtimeVersion: "sherpa-onnx-1.13.4-ios-no-tts",
      manifestSha256: manifestSHA,
      activationGeneration: 1,
      resultId: firstResultId,
      resultPayloadSha256: String(repeating: "d", count: 64)
    ), "the one legacy result with an exact retained digest remains replayable")
    expect(try! Data(contentsOf: resultURL) == migratedData,
      "exact replay is idempotent and does not rewrite the migrated record")
    let newResultId = "npr_44444444444444444444444444444444"
    expect(try! lifecycle.noteExactResult(
      modelId: "qwen3-0.6b-int8",
      modelVersion: "synthetic-1",
      runtimeVersion: "sherpa-onnx-1.13.4-ios-no-tts",
      manifestSha256: manifestSHA,
      activationGeneration: 1,
      resultId: newResultId,
      resultPayloadSha256: String(repeating: "f", count: 64)
    ), "new exact results may extend a migrated record without promoting legacy unknowns")
    let replayed = MainaModelPackLifecycle(root: root)
    expect(try! replayed.noteExactResult(
      modelId: "qwen3-0.6b-int8",
      modelVersion: "synthetic-1",
      runtimeVersion: "sherpa-onnx-1.13.4-ios-no-tts",
      manifestSha256: manifestSHA,
      activationGeneration: 1,
      resultId: newResultId,
      resultPayloadSha256: String(repeating: "f", count: 64)
    ), "process replay preserves the newly bound exact result")
    let extended = try! JSONSerialization.jsonObject(with: Data(contentsOf: resultURL)) as! [String: Any]
    expect((extended["resultPayloadSha256ById"] as? [String: String])?[newResultId]
      == String(repeating: "f", count: 64), "the post-migration result digest is durable")
    expect(extended["unverifiedLegacyResultIds"] as? [String] == [unverifiedResultId],
      "extending a migrated record preserves the legacy uncertainty fence")
  }
  passed += 1
}

private func testResultRecordSchemaAndLocationFailClosed() {
  withTemporaryRoot("result-schema") { root in
    let prepared = prepareReadyLifecycle(root)
    let firstResultId = "npr_55555555555555555555555555555555"
    let secondResultId = "npr_66666666666666666666666666666666"
    expect(try! bindResult(prepared.lifecycle, manifestSHA: prepared.manifestSHA,
      resultId: firstResultId, payloadSHA: String(repeating: "a", count: 64)),
      "schema fixture records its first result")
    expect(try! bindResult(prepared.lifecycle, manifestSHA: prepared.manifestSHA,
      resultId: secondResultId, payloadSHA: String(repeating: "b", count: 64)),
      "schema fixture records its second result")
    let canonicalData = try! Data(contentsOf: prepared.resultURL)
    let thirdResultId = "npr_77777777777777777777777777777777"

    func assertCorruptionRejected(_ message: String, mutate: (inout [String: Any]) -> Void) {
      var object = try! JSONSerialization.jsonObject(with: canonicalData) as! [String: Any]
      mutate(&object)
      writeJSON(object, to: prepared.resultURL)
      expect(bindResultRejected(prepared.lifecycle, manifestSHA: prepared.manifestSHA,
        resultId: thirdResultId, payloadSHA: String(repeating: "c", count: 64)), message)
      try! canonicalData.write(to: prepared.resultURL)
    }

    assertCorruptionRejected("an unknown top-level field fails closed") { object in
      object["unexpected"] = true
    }
    assertCorruptionRejected("a missing v2 field cannot masquerade as legacy") { object in
      object.removeValue(forKey: "unverifiedLegacyResultIds")
    }
    assertCorruptionRejected("an unknown result schema version fails closed") { object in
      object["schemaVersion"] = "maina.model-pack-result-record.v3"
    }
    assertCorruptionRejected("duplicate referenced result IDs fail closed") { object in
      object["referencedResultIds"] = [firstResultId, firstResultId, secondResultId]
    }
    assertCorruptionRejected("verified and unverified identity sets may not overlap") { object in
      object["unverifiedLegacyResultIds"] = [secondResultId]
    }
    assertCorruptionRejected("every referenced result must have verified or legacy evidence") { object in
      object["resultPayloadSha256ById"] = [firstResultId: String(repeating: "a", count: 64)]
    }
    assertCorruptionRejected("the first result digest cannot drift from its map entry") { object in
      object["firstExactResultSha256"] = String(repeating: "d", count: 64)
    }

    let foreignURL = root.appendingPathComponent("results/\(String(repeating: "e", count: 64))-1.json")
    try! canonicalData.write(to: foreignURL)
    expect(bindResultRejected(prepared.lifecycle, manifestSHA: prepared.manifestSHA,
      resultId: thirdResultId, payloadSHA: String(repeating: "c", count: 64)),
      "a valid record under a mismatched manifest-generation filename fails closed")
    expect(try! Data(contentsOf: foreignURL) == canonicalData,
      "a location mismatch cannot rewrite or migrate the foreign record")
    try! FileManager.default.removeItem(at: foreignURL)

    let hiddenURL = root.appendingPathComponent("results/.unexpected-result-state")
    try! Data("{}".utf8).write(to: hiddenURL)
    expect(bindResultRejected(prepared.lifecycle, manifestSHA: prepared.manifestSHA,
      resultId: thirdResultId, payloadSHA: String(repeating: "c", count: 64)),
      "hidden result-state entries are not skipped")
  }

  withTemporaryRoot("legacy-corruption") { root in
    let prepared = prepareReadyLifecycle(root)
    let firstResultId = "npr_88888888888888888888888888888888"
    let legacy: [String: Any] = [
      "manifestSha256": prepared.manifestSHA,
      "platform": "ios",
      "activationGeneration": 1,
      "modelId": "qwen3-0.6b-int8",
      "modelVersion": "synthetic-1",
      "runtimeVersion": "sherpa-onnx-1.13.4-ios-no-tts",
      "lifecycleRecordSha256": prepared.lifecycleRecordSHA,
      "packRetained": true,
      "firstExactResultId": firstResultId,
      "firstExactResultSha256": String(repeating: "a", count: 64),
      "referencedResultIds": [firstResultId, firstResultId],
    ]
    writeJSON(legacy, to: prepared.resultURL)
    let corruptData = try! Data(contentsOf: prepared.resultURL)
    expect(bindResultRejected(prepared.lifecycle, manifestSHA: prepared.manifestSHA,
      resultId: firstResultId, payloadSHA: String(repeating: "a", count: 64)),
      "a malformed legacy record fails before migration")
    expect(try! Data(contentsOf: prepared.resultURL) == corruptData,
      "failed legacy validation leaves the original evidence byte-exact")
  }
  passed += 1
}

private func withTemporaryRoot(_ suffix: String, body: (URL) -> Void) {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("maina-model-pack-ios-\(suffix)-\(UUID().uuidString)", isDirectory: true)
  try! FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: root) }
  body(root)
}

private func rehashManifest(_ manifest: inout [String: Any]) {
  manifest.removeValue(forKey: "manifestSha256")
  manifest["manifestSha256"] = sha256(canonicalJSON(manifest))
}

private func manifestBeginFailure(_ manifest: [String: Any], root: URL) -> String {
  let data = try! JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys])
  let text = String(data: data, encoding: .utf8)!
  do {
    _ = try MainaModelPackLifecycle(root: root).begin(
      manifestJSON: text,
      partialOverheadBytes: 0,
      safetyMarginBytes: 0
    )
    return "NONE"
  } catch {
    return (error as NSError).localizedDescription
  }
}

private func expectNoAcquisitionState(_ root: URL) {
  expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("writer.json").path),
    "rejected manifests cannot create a writer")
  expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("current.json").path),
    "rejected manifests cannot create current acquisition state")
  let staging = root.appendingPathComponent("staging", isDirectory: true)
  let entries = (try? FileManager.default.contentsOfDirectory(atPath: staging.path)) ?? []
  expect(entries.isEmpty, "rejected manifests cannot create a staging acquisition")
}

private func prepareReadyLifecycle(_ root: URL) -> (
  lifecycle: MainaModelPackLifecycle,
  manifestSHA: String,
  lifecycleRecordSHA: String,
  resultURL: URL
) {
  let manifest = syntheticManifest()
  let manifestSHA = manifest["manifestSha256"] as! String
  let pack = root.appendingPathComponent("packs/\(manifestSHA)", isDirectory: true)
  try! FileManager.default.createDirectory(at: pack, withIntermediateDirectories: true)
  writeJSON(manifest, to: pack.appendingPathComponent("manifest.json"))
  let lifecycleRecordURL = root.appendingPathComponent("records/\(manifestSHA).json")
  writeJSON(record(manifest, state: "ready", reason: "NONE", generation: 1), to: lifecycleRecordURL)
  writeJSON(pointer(manifest, generation: 1), to: root.appendingPathComponent("ready.json"))
  return (
    MainaModelPackLifecycle(root: root),
    manifestSHA,
    sha256(String(data: try! Data(contentsOf: lifecycleRecordURL), encoding: .utf8)!),
    root.appendingPathComponent("results/\(manifestSHA)-1.json")
  )
}

private func bindResult(
  _ lifecycle: MainaModelPackLifecycle,
  manifestSHA: String,
  resultId: String,
  payloadSHA: String
) throws -> Bool {
  try lifecycle.noteExactResult(
    modelId: "qwen3-0.6b-int8",
    modelVersion: "synthetic-1",
    runtimeVersion: "sherpa-onnx-1.13.4-ios-no-tts",
    manifestSha256: manifestSHA,
    activationGeneration: 1,
    resultId: resultId,
    resultPayloadSha256: payloadSHA
  )
}

private func bindResultRejected(
  _ lifecycle: MainaModelPackLifecycle,
  manifestSHA: String,
  resultId: String,
  payloadSHA: String
) -> Bool {
  do {
    return try bindResult(lifecycle, manifestSHA: manifestSHA, resultId: resultId, payloadSHA: payloadSHA) == false
  } catch {
    return true
  }
}

private let requiredFiles: [(String, UInt64)] = [
  ("conv_frontend.onnx", 44_148_281),
  ("encoder.int8.onnx", 182_491_662),
  ("decoder.int8.onnx", 755_914_231),
  ("tokenizer/vocab.json", 2_776_833),
  ("tokenizer/merges.txt", 1_671_853),
  ("tokenizer/tokenizer_config.json", 12_487),
]

private func writer(_ manifestSHA: String) -> [String: Any] {
  ["manifestSha256": manifestSHA, "platform": "ios"]
}

private func record(_ manifest: [String: Any], state: String, reason: String, generation: UInt64 = 0) -> [String: Any] {
  let total = requiredFiles.reduce(UInt64(0)) { $0 + $1.1 }
  return [
    "schemaVersion": "maina.model-pack-lifecycle-record.v1",
    "packId": "qwen3-asr-0.6b-int8",
    "packVersion": manifest["packVersion"]!,
    "manifestSha256": manifest["manifestSha256"]!,
    "platform": "ios",
    "activationGeneration": generation,
    "state": state,
    "bytesComplete": state == "downloading" ? 0 : total,
    "bytesTotal": total,
    "reasonCode": reason,
    "verifiedChunks": [String: [String]](),
  ]
}

private func pointer(_ manifest: [String: Any], generation: UInt64) -> [String: Any] {
  [
    "packId": "qwen3-asr-0.6b-int8",
    "packVersion": manifest["packVersion"]!,
    "manifestSha256": manifest["manifestSha256"]!,
    "platform": "ios",
    "activationGeneration": generation,
    "runtimeVersion": "sherpa-onnx-1.13.4-ios-no-tts",
  ]
}

private func syntheticManifest(packVersion: String = "synthetic-1", hashCharacter: Character? = nil) -> [String: Any] {
  let files: [[String: Any]] = requiredFiles.enumerated().map { index, value in
    let hash = String(repeating: hashCharacter.map(String.init) ?? String(index + 1), count: 64)
    return [
      "path": value.0,
      "byteCount": value.1,
      "sha256": hash,
      "chunkSizeBytes": value.1,
      "chunkSha256": [hash],
    ]
  }
  var manifest: [String: Any] = [
    "schemaVersion": "maina.model-pack-manifest.v1",
    "packId": "qwen3-asr-0.6b-int8",
    "packVersion": packVersion,
    "engineId": "qwen3-0.6b-int8",
    "formatVersion": "1",
    "files": files,
    "platforms": [
      platform("android", "26", "arm64-v8a", "sherpa-onnx-1.13.6", "0012d9a28f15bd6fb966b62b70a75da3990512fdccce28b83098248ce4be1698", String(repeating: "a", count: 64)),
      platform("ios", "17.0", "arm64", "sherpa-onnx-1.13.4-ios-no-tts", "d8baaa925248e8e8ad23870208cdaf3d093623e6733aede2c23862f30c5aac62", String(repeating: "b", count: 64)),
    ],
    "smokeInputSha256": String(repeating: hashCharacter.map(String.init) ?? "c", count: 64),
  ]
  manifest["manifestSha256"] = sha256(canonicalJSON(manifest))
  return manifest
}

private func platform(_ os: String, _ min: String, _ architecture: String, _ runtime: String, _ runtimeSHA: String, _ smokeSHA: String) -> [String: Any] {
  [
    "osFamily": os, "minOsVersion": min, "architectures": [architecture],
    "runtimeVersion": runtime, "runtimeSha256": runtimeSHA, "smokeExpectedTextSha256": smokeSHA,
  ]
}

private func writeJSON(_ value: Any, to url: URL) {
  try! FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
  try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]).write(to: url)
}

private func canonicalJSON(_ value: Any) -> String {
  if value is NSNull { return "null" }
  if let string = value as? String {
    let encoded = String(data: try! JSONSerialization.data(withJSONObject: [string]), encoding: .utf8)!
    return String(encoded.dropFirst().dropLast())
  }
  if let number = value as? NSNumber {
    if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue ? "true" : "false" }
    return number.stringValue
  }
  if let array = value as? [Any] { return "[" + array.map(canonicalJSON).joined(separator: ",") + "]" }
  if let object = value as? [String: Any] {
    return "{" + object.keys.sorted().map { key in
      canonicalJSON(key) + ":" + canonicalJSON(object[key]!)
    }.joined(separator: ",") + "}"
  }
  fatalError("unsupported fixture value")
}

private func sha256(_ value: String) -> String {
  SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
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
    testBoundedVersionComparisonDoesNotNarrow()
    testManifestScalarAndContainerShapesFailClosed()
    testPlatformReasonsAndHostileMinimumFailBeforeAcquisition()
    testPreRenameCrashUsesStagingAndClearsWriter()
    testStatusExposesAcquisitionAndTerminalFailure()
    testResultMappingUsesEngineIdentity()
    testLegacyResultMappingMigrationFailsClosed()
    testResultRecordSchemaAndLocationFailClosed()
    print("Maina iOS model-pack lifecycle policy tests passed: \(passed)/14")
  }
}
