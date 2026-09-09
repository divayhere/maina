import CryptoKit
import CoreFoundation
import Darwin
import Foundation

enum MainaModelPackLifecyclePolicy {
  private static let transitions = Set([
    "unavailable>downloading:manifest_valid_and_space_preflight_passed",
    "downloading>downloading:exact_chunk_progress_committed",
    "downloading>verifying:all_declared_bytes_present",
    "downloading>failed_download:bounded_download_failure_recorded",
    "failed_download>downloading:same_manifest_and_verified_prefix",
    "verifying>staged:exact_file_set_bytes_and_hashes_verified",
    "verifying>failed_verification:verification_failure_recorded",
    "failed_verification>downloading:same_manifest_invalid_bytes_removed",
    "staged>smoke_testing:compatible_platform_runtime_selected",
    "smoke_testing>ready:smoke_receipt_and_atomic_pointer_durable",
    "smoke_testing>failed_smoke:smoke_failure_recorded",
    "ready>rollback_pending:pre_first_result_open_or_identity_failure",
    "rollback_pending>failed_smoke:previous_ready_pointer_restored",
    "ready>downloading:different_valid_manifest_staged_without_active_mutation",
  ])

  static func transitionAllowed(from: String, to: String, guard guardName: String) -> Bool {
    transitions.contains("\(from)>\(to):\(guardName)")
  }

  static func resumePrefix(
    storedManifest: String,
    requestedManifest: String,
    storedPath: String,
    requestedPath: String,
    storedBytes: UInt64,
    requestedBytes: UInt64,
    storedPlatform: String,
    requestedPlatform: String,
    storedChunks: [String],
    requestedChunks: [String],
    declaredChunks: [String]
  ) -> Int? {
    guard storedManifest == requestedManifest, storedPath == requestedPath,
      storedBytes == requestedBytes, storedPlatform == requestedPlatform,
      storedChunks == requestedChunks, storedChunks.count <= declaredChunks.count,
      Array(declaredChunks.prefix(storedChunks.count)) == storedChunks
    else { return nil }
    return storedChunks.count
  }

  static func requiredSpace(
    newPackBytes: UInt64,
    partialOverheadBytes: UInt64,
    retainedRollbackBytes: UInt64,
    safetyMarginBytes: UInt64
  ) -> UInt64? {
    let (first, firstOverflow) = newPackBytes.addingReportingOverflow(partialOverheadBytes)
    let (second, secondOverflow) = retainedRollbackBytes.addingReportingOverflow(safetyMarginBytes)
    let (total, totalOverflow) = first.addingReportingOverflow(second)
    return firstOverflow || secondOverflow || totalOverflow ? nil : total
  }

  static func promotionAllowed(
    manifestVerified: Bool,
    platformCompatible: Bool,
    smokePassed: Bool,
    previousReadyRetained: Bool,
    conflictingWriter: Bool,
    stagedDurable: Bool
  ) -> Bool {
    manifestVerified && platformCompatible && smokePassed && previousReadyRetained && !conflictingWriter && stagedDurable
  }

  static func cleanupAllowed(
    targetActive: Bool,
    rollbackRetained: Bool,
    inProgress: Bool,
    pinnedReaders: Int,
    resultReferences: Int,
    exactSuccessorResult: Bool
  ) -> Bool {
    !targetActive && !rollbackRetained && !inProgress && pinnedReaders == 0
      && resultReferences == 0 && exactSuccessorResult
  }

  static func interruptedPromotionAction(
    recordState: String,
    readyPointsToWriter: Bool,
    previousPointerValid: Bool
  ) -> String {
    if recordState == "ready", readyPointsToWriter { return "complete_success_cleanup" }
    guard recordState == "smoke_testing" else { return "none" }
    if !readyPointsToWriter { return "mark_failed_preserve_current" }
    return previousPointerValid ? "rollback_to_previous" : "invalidate_first_activation"
  }
}

final class MainaModelPackLifecycle {
  static let shared = MainaModelPackLifecycle()

  struct SmokeEvidence {
    let inputSha256: String
    let normalizedTextSha256: String
    let startedAt: Int64
    let completedAt: Int64
  }

  struct PublicStatus {
    let packVersion: String?
    let state: String
    let bytesComplete: UInt64
    let bytesTotal: UInt64
    let reasonCode: String
    let platformCompatible: Bool

    var dictionary: [String: Any] {
      [
        "packId": Self.packId,
        "packVersion": packVersion ?? NSNull(),
        "state": state,
        "bytesComplete": bytesComplete,
        "bytesTotal": bytesTotal,
        "reasonCode": reasonCode,
        "platformCompatible": platformCompatible,
      ]
    }

    private static let packId = "qwen3-asr-0.6b-int8"
  }

  final class ReadyHandle {
    let root: URL
    let packVersion: String
    let manifestSha256: String
    let activationGeneration: UInt64
    let runtimeVersion: String
    private var pin: URL?

    fileprivate init(
      root: URL,
      packVersion: String,
      manifestSha256: String,
      activationGeneration: UInt64,
      runtimeVersion: String,
      pin: URL
    ) {
      self.root = root
      self.packVersion = packVersion
      self.manifestSha256 = manifestSha256
      self.activationGeneration = activationGeneration
      self.runtimeVersion = runtimeVersion
      self.pin = pin
    }

    func release() throws {
      guard let pin else { return }
      try FileManager.default.removeItem(at: pin)
      self.pin = nil
    }

    deinit { try? release() }
  }

  private struct ManifestFile: Codable {
    let path: String
    let byteCount: UInt64
    let sha256: String
    let chunkSizeBytes: UInt64
    let chunkSha256: [String]
  }

  private struct ManifestPlatform: Codable {
    let osFamily: String
    let minOsVersion: String
    let architectures: [String]
    let runtimeVersion: String
    let runtimeSha256: String
    let smokeExpectedTextSha256: String
  }

  private struct Manifest: Codable {
    let schemaVersion: String
    let packId: String
    let packVersion: String
    let engineId: String
    let formatVersion: String
    let files: [ManifestFile]
    let platforms: [ManifestPlatform]
    let smokeInputSha256: String
    let manifestSha256: String

    var bytesTotal: UInt64 { files.reduce(0) { $0 + $1.byteCount } }
    var platform: ManifestPlatform { platforms.first { $0.osFamily == Self.platformName }! }
    private static let platformName = "ios"
  }

  private struct Pointer: Codable {
    let packId: String
    let packVersion: String
    let manifestSha256: String
    let platform: String
    let activationGeneration: UInt64
    let runtimeVersion: String
  }

  private struct Writer: Codable {
    let manifestSha256: String
    let platform: String
  }

  private struct Record: Codable {
    let schemaVersion: String
    let packId: String
    let packVersion: String
    let manifestSha256: String
    let platform: String
    let activationGeneration: UInt64
    let state: String
    let bytesComplete: UInt64
    let bytesTotal: UInt64
    let reasonCode: String
    let verifiedChunks: [String: [String]]
  }

  private let fileManager: FileManager
  private let root: URL

  init(root: URL? = nil, fileManager: FileManager = .default) {
    self.fileManager = fileManager
    if let root {
      self.root = root
    } else {
      let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      self.root = support.appendingPathComponent("Maina/model-packs-v1", isDirectory: true)
    }
    try? ensureDirectories()
  }

  func status() throws -> PublicStatus {
    try withWriterLock {
      try reconcileInterruptedPromotion()
      guard let pointer: Pointer = try readExact(readyPointer, keys: pointerKeys) else {
        return .init(packVersion: nil, state: "unavailable", bytesComplete: 0, bytesTotal: 0, reasonCode: "NONE", platformCompatible: platformCompatible())
      }
      guard validPointer(pointer),
        let record = try readRecord(pointer.manifestSha256), record.state == "ready",
        record.packVersion == pointer.packVersion,
        record.activationGeneration == pointer.activationGeneration,
        let manifest = try readManifest(packDirectory(pointer.manifestSha256)),
        manifest.manifestSha256 == pointer.manifestSha256,
        manifest.packVersion == pointer.packVersion
      else {
        return .init(packVersion: nil, state: "rollback_pending", bytesComplete: 0, bytesTotal: 0, reasonCode: "READY_POINTER_INVALID", platformCompatible: platformCompatible())
      }
      return .init(packVersion: pointer.packVersion, state: "ready", bytesComplete: record.bytesComplete, bytesTotal: record.bytesTotal, reasonCode: "NONE", platformCompatible: platformCompatible())
    }
  }

  func begin(manifestJSON: String, partialOverheadBytes: UInt64, safetyMarginBytes: UInt64) throws -> PublicStatus {
    try withWriterLock {
      try reconcileInterruptedPromotion()
      let manifest = try parseManifest(manifestJSON)
      try requirePlatformCompatible(manifest)
      if let writer: Writer = try readExact(writerURL, keys: writerKeys) {
        guard validSHA(writer.manifestSha256), writer.platform == Self.platformName else {
          throw failure("MODEL_PACK_WRITER_IDENTITY_MISMATCH")
        }
        if writer.manifestSha256 != manifest.manifestSha256 { throw failure("MODEL_PACK_WRITER_CONFLICT") }
      }
      guard let required = MainaModelPackLifecyclePolicy.requiredSpace(
        newPackBytes: manifest.bytesTotal,
        partialOverheadBytes: partialOverheadBytes,
        retainedRollbackBytes: try retainedRollbackBytes(),
        safetyMarginBytes: safetyMarginBytes
      ), try availableBytes() >= required else { throw failure("STORAGE_PREFLIGHT_FAILED") }

      try writeAtomic(Writer(manifestSha256: manifest.manifestSha256, platform: Self.platformName), to: writerURL)
      let stage = stagingDirectory(manifest.manifestSha256)
      let previous = try readRecord(manifest.manifestSha256)
      if previous?.state == "failed_verification", fileManager.fileExists(atPath: stage.path) {
        try fileManager.removeItem(at: stage)
        try fsyncDirectory(stagingRoot)
      }
      try ensureDirectory(stage)
      try writeDataAtomic(Data(manifestJSON.utf8), to: stage.appendingPathComponent("manifest.json"))
      let priorState = previous?.state ?? "unavailable"
      let guardName: String
      switch priorState {
      case "failed_download": guardName = "same_manifest_and_verified_prefix"
      case "failed_verification": guardName = "same_manifest_invalid_bytes_removed"
      default: guardName = "manifest_valid_and_space_preflight_passed"
      }
      guard ["unavailable", "failed_download", "failed_verification", "downloading"].contains(priorState),
        priorState == "downloading" || MainaModelPackLifecyclePolicy.transitionAllowed(from: priorState, to: "downloading", guard: guardName)
      else { throw failure("LIFECYCLE_TRANSITION_INVALID") }
      let progress = try scanVerifiedProgress(stage, manifest: manifest)
      try writeRecord(manifest, state: "downloading", bytesComplete: progress.bytes, reasonCode: "NONE", progress: progress.chunks)
      return publicStatus(manifest, state: "downloading", bytes: progress.bytes, reason: "NONE")
    }
  }

  func stageChunk(manifestJSON: String, relativePath: String, chunkIndex: Int, sourceURI: String) throws -> PublicStatus {
    try withWriterLock {
      let manifest = try parseManifest(manifestJSON)
      try requireWriter(manifest)
      let record = try requireRecord(manifest, states: ["downloading", "failed_download"])
      guard let spec = manifest.files.first(where: { $0.path == relativePath }), spec.chunkSha256.indices.contains(chunkIndex),
        let source = URL(string: sourceURI), source.isFileURL, try regularFile(source)
      else { throw failure("CHUNK_SOURCE_INVALID") }
      let progress = record.verifiedChunks
      let completed = progress[relativePath] ?? []
      guard chunkIndex == completed.count else { throw failure("RESUME_PREFIX_INVALID") }
      let expectedBytes = min(spec.chunkSizeBytes, spec.byteCount - spec.chunkSizeBytes * UInt64(chunkIndex))
      guard try fileSize(source) == expectedBytes, try sha256(source) == spec.chunkSha256[chunkIndex] else {
        try fail(manifest, state: "failed_download", reason: "DOWNLOAD_CHUNK_MISMATCH", progress: progress)
        throw failure("DOWNLOAD_CHUNK_MISMATCH")
      }
      let target = try safeChild(stagingDirectory(manifest.manifestSha256), relativePath)
      try ensureDirectory(target.deletingLastPathComponent())
      let currentBytes = UInt64(completed.count) * spec.chunkSizeBytes
      let exists = fileManager.fileExists(atPath: target.path)
      let targetMatchesPrefix = exists ? (try regularFile(target) && fileSize(target) == currentBytes) : currentBytes == 0
      guard targetMatchesPrefix else {
        try fail(manifest, state: "failed_download", reason: "RESUME_PREFIX_INVALID", progress: progress)
        throw failure("RESUME_PREFIX_INVALID")
      }
      if !exists, !fileManager.createFile(atPath: target.path, contents: nil) {
        throw failure("MODEL_PACK_STORAGE_INVALID")
      }
      let output = try FileHandle(forWritingTo: target)
      defer { try? output.close() }
      try output.seekToEnd()
      let input = try FileHandle(forReadingFrom: source)
      defer { try? input.close() }
      var copied: UInt64 = 0
      while true {
        let data = try input.read(upToCount: 1024 * 1024) ?? Data()
        if data.isEmpty { break }
        try output.write(contentsOf: data)
        copied += UInt64(data.count)
      }
      guard copied == expectedBytes else { throw failure("CHUNK_SOURCE_INVALID") }
      try output.synchronize()
      var next = progress
      next[relativePath] = completed + [spec.chunkSha256[chunkIndex]]
      let bytes = verifiedBytes(next, manifest: manifest)
      try writeRecord(manifest, state: "downloading", bytesComplete: bytes, reasonCode: "NONE", progress: next)
      return publicStatus(manifest, state: "downloading", bytes: bytes, reason: "NONE")
    }
  }

  func verifyStaged(manifestJSON: String) throws -> PublicStatus {
    try withWriterLock {
      let manifest = try parseManifest(manifestJSON)
      try requireWriter(manifest)
      _ = try requireRecord(manifest, states: ["downloading"])
      let stage = stagingDirectory(manifest.manifestSha256)
      let observed = try enumerateFiles(stage).filter { $0 != "manifest.json" }
      guard Set(observed) == Set(manifest.files.map(\.path)) else {
        try fail(manifest, state: "failed_verification", reason: "MANIFEST_FILE_SET_MISMATCH", progress: [:])
        throw failure("MANIFEST_FILE_SET_MISMATCH")
      }
      try writeRecord(manifest, state: "verifying", bytesComplete: manifest.bytesTotal, reasonCode: "NONE", progress: completeProgress(manifest))
      for spec in manifest.files {
        let file = try safeChild(stage, spec.path)
        guard try regularFile(file), try fileSize(file) == spec.byteCount,
          try sha256(file) == spec.sha256, try chunkHashes(file, chunkSize: spec.chunkSizeBytes) == spec.chunkSha256
        else {
          try fail(manifest, state: "failed_verification", reason: "FILE_EVIDENCE_MISMATCH", progress: [:])
          throw failure("FILE_EVIDENCE_MISMATCH")
        }
      }
      try writeRecord(manifest, state: "staged", bytesComplete: manifest.bytesTotal, reasonCode: "NONE", progress: completeProgress(manifest))
      return publicStatus(manifest, state: "staged", bytes: manifest.bytesTotal, reason: "NONE")
    }
  }

  func smokeRoot(manifestJSON: String) throws -> URL {
    try withWriterLock {
      let manifest = try parseManifest(manifestJSON)
      try requireWriter(manifest)
      _ = try requireRecord(manifest, states: ["staged"])
      return stagingDirectory(manifest.manifestSha256)
    }
  }

  func promote(manifestJSON: String, evidence: SmokeEvidence) throws -> PublicStatus {
    try withWriterLock {
      let manifest = try parseManifest(manifestJSON)
      try requireWriter(manifest)
      _ = try requireRecord(manifest, states: ["staged"])
      guard evidence.inputSha256 == manifest.smokeInputSha256,
        evidence.normalizedTextSha256 == manifest.platform.smokeExpectedTextSha256,
        evidence.startedAt >= 0, evidence.completedAt >= evidence.startedAt
      else {
        try fail(manifest, state: "failed_smoke", reason: "SMOKE_RECEIPT_MISMATCH", progress: completeProgress(manifest))
        throw failure("SMOKE_RECEIPT_MISMATCH")
      }
      try writeRecord(manifest, state: "smoke_testing", bytesComplete: manifest.bytesTotal, reasonCode: "NONE", progress: completeProgress(manifest))
      let previous: Pointer? = try readExact(readyPointer, keys: pointerKeys)
      if let previous {
        guard validPointer(previous), let retained = try readManifest(packDirectory(previous.manifestSha256)),
          retained.manifestSha256 == previous.manifestSha256,
          retained.packVersion == previous.packVersion
        else { throw failure("ROLLBACK_RETENTION_FAILED") }
      } else if fileManager.fileExists(atPath: previousPointer.path) {
        try fileManager.removeItem(at: previousPointer)
        try fsyncDirectory(root)
      }
      let destination = packDirectory(manifest.manifestSha256)
      guard !fileManager.fileExists(atPath: destination.path) else { throw failure("PROMOTION_ATOMICITY_FAILED") }
      try fileManager.moveItem(at: stagingDirectory(manifest.manifestSha256), to: destination)
      try fsyncDirectory(packsRoot)
      if let previous { try writeAtomic(previous, to: previousPointer) }
      let generation = (previous?.activationGeneration ?? 0) + 1
      let pointer = Pointer(packId: Self.packID, packVersion: manifest.packVersion, manifestSha256: manifest.manifestSha256, platform: Self.platformName, activationGeneration: generation, runtimeVersion: Self.runtimeVersion)
      try writeAtomic(pointer, to: readyPointer)
      try writeRecord(manifest, state: "ready", bytesComplete: manifest.bytesTotal, reasonCode: "NONE", progress: completeProgress(manifest), activationGeneration: generation)
      try? fileManager.removeItem(at: writerURL)
      try fsyncDirectory(root)
      return publicStatus(manifest, state: "ready", bytes: manifest.bytesTotal, reason: "NONE")
    }
  }

  func acquireReady() throws -> ReadyHandle? {
    try withWriterLock {
      try reconcileInterruptedPromotion()
      guard let pointer: Pointer = try readExact(readyPointer, keys: pointerKeys), validPointer(pointer),
        let record = try readRecord(pointer.manifestSha256), record.state == "ready"
        , record.packVersion == pointer.packVersion, record.activationGeneration == pointer.activationGeneration
      else { return nil }
      let pack = packDirectory(pointer.manifestSha256)
      guard let manifest = try readManifest(pack), manifest.manifestSha256 == pointer.manifestSha256,
        manifest.packVersion == pointer.packVersion
      else { return nil }
      let readers = readersRoot.appendingPathComponent(pointer.manifestSha256, isDirectory: true)
      try ensureDirectory(readers)
      let pin = readers.appendingPathComponent(UUID().uuidString)
      guard fileManager.createFile(atPath: pin.path, contents: Data("generation=\(pointer.activationGeneration)\n".utf8)) else {
        throw failure("MODEL_PACK_READER_PIN_FAILED")
      }
      try fsyncFile(pin)
      return ReadyHandle(
        root: pack,
        packVersion: pointer.packVersion,
        manifestSha256: pointer.manifestSha256,
        activationGeneration: pointer.activationGeneration,
        runtimeVersion: pointer.runtimeVersion,
        pin: pin
      )
    }
  }

  func rollbackAfterOpenFailure(_ handle: ReadyHandle) throws -> Bool {
    try withWriterLock {
      guard let current: Pointer = try readExact(readyPointer, keys: pointerKeys),
        current.manifestSha256 == handle.manifestSha256,
        current.activationGeneration == handle.activationGeneration,
        let currentManifest = try? parseManifest(String(contentsOf: packDirectory(handle.manifestSha256).appendingPathComponent("manifest.json"), encoding: .utf8))
      else { return false }
      try writeRecord(currentManifest, state: "rollback_pending", bytesComplete: currentManifest.bytesTotal, reasonCode: "MODEL_OPEN_FAILED", progress: completeProgress(currentManifest), activationGeneration: handle.activationGeneration)
      if let previous: Pointer = try readExact(previousPointer, keys: pointerKeys) {
        try writeAtomic(previous, to: readyPointer)
        try? fileManager.removeItem(at: previousPointer)
      } else {
        try? fileManager.removeItem(at: readyPointer)
      }
      try writeRecord(currentManifest, state: "failed_smoke", bytesComplete: currentManifest.bytesTotal, reasonCode: "MODEL_OPEN_FAILED_ROLLED_BACK", progress: completeProgress(currentManifest), activationGeneration: handle.activationGeneration)
      try fsyncDirectory(root)
      return true
    }
  }

  private func parseManifest(_ text: String) throws -> Manifest {
    guard let data = text.data(using: .utf8),
      let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { throw failure("MANIFEST_INVALID") }
    try exactKeys(object, expected: manifestKeys, code: "MANIFEST_INVALID")
    guard object["schemaVersion"] as? String == "maina.model-pack-manifest.v1",
      object["packId"] as? String == Self.packID, object["engineId"] as? String == Self.packID,
      object["formatVersion"] as? String == "1", let packVersion = object["packVersion"] as? String,
      validID(packVersion), let smokeInput = object["smokeInputSha256"] as? String, validSHA(smokeInput),
      let manifestSHA = object["manifestSha256"] as? String, validSHA(manifestSHA),
      let fileObjects = object["files"] as? [[String: Any]], let platformObjects = object["platforms"] as? [[String: Any]]
    else { throw failure("MANIFEST_INVALID") }
    for file in fileObjects { try exactKeys(file, expected: fileKeys, code: "MANIFEST_INVALID") }
    for platform in platformObjects { try exactKeys(platform, expected: platformKeys, code: "MANIFEST_INVALID") }
    let decoded = try JSONDecoder().decode(Manifest.self, from: data)
    var paths = Set<String>()
    var folded = Set<String>()
    for file in decoded.files {
      guard safeRelativePath(file.path), requiredFiles[file.path] == file.byteCount,
        validSHA(file.sha256), file.chunkSizeBytes > 0,
        file.chunkSha256.count == Int(((file.byteCount - 1) / file.chunkSizeBytes) + 1),
        file.chunkSha256.allSatisfy(validSHA), paths.insert(file.path).inserted,
        folded.insert(file.path.lowercased()).inserted
      else { throw failure("MANIFEST_PATH_INVALID") }
    }
    guard paths == Set(requiredFiles.keys), decoded.platforms.count == 2,
      Set(decoded.platforms.map(\.osFamily)) == Set(["android", "ios"])
    else { throw failure("MANIFEST_FILE_SET_MISMATCH") }
    for platform in decoded.platforms {
      guard ["android", "ios"].contains(platform.osFamily), validVersion(platform.minOsVersion),
        !platform.architectures.isEmpty, Set(platform.architectures).count == platform.architectures.count,
        platform.architectures.allSatisfy(validID), validID(platform.runtimeVersion),
        validSHA(platform.runtimeSha256), validSHA(platform.smokeExpectedTextSha256)
      else { throw failure("MANIFEST_INVALID") }
    }
    var unsigned = object
    unsigned.removeValue(forKey: "manifestSha256")
    guard sha256(Data(try canonicalJSON(unsigned).utf8)) == manifestSHA else { throw failure("MANIFEST_HASH_MISMATCH") }
    return decoded
  }

  private func requirePlatformCompatible(_ manifest: Manifest) throws {
    guard platformCompatible(), manifest.platform.architectures.contains("arm64"),
      manifest.platform.runtimeVersion == Self.runtimeVersion,
      manifest.platform.runtimeSha256 == Self.runtimeSHA256,
      compareVersions(Self.osVersion(), manifest.platform.minOsVersion) >= 0
    else { throw failure("PLATFORM_COMPATIBILITY_MISMATCH") }
  }

  private func platformCompatible() -> Bool {
    #if arch(arm64)
    return compareVersions(Self.osVersion(), "17.0") >= 0
    #else
    return false
    #endif
  }

  private func scanVerifiedProgress(_ stage: URL, manifest: Manifest) throws -> (bytes: UInt64, chunks: [String: [String]]) {
    var progress: [String: [String]] = [:]
    for spec in manifest.files {
      let file = try safeChild(stage, spec.path)
      guard fileManager.fileExists(atPath: file.path) else { continue }
      guard try regularFile(file), try fileSize(file) <= spec.byteCount else { throw failure("RESUME_PREFIX_INVALID") }
      let size = try fileSize(file)
      guard size % spec.chunkSizeBytes == 0 || size == spec.byteCount else { throw failure("RESUME_PREFIX_INVALID") }
      let hashes = try chunkHashes(file, chunkSize: spec.chunkSizeBytes)
      guard hashes.count <= spec.chunkSha256.count,
        Array(spec.chunkSha256.prefix(hashes.count)) == hashes
      else { throw failure("RESUME_PREFIX_INVALID") }
      progress[spec.path] = hashes
    }
    return (verifiedBytes(progress, manifest: manifest), progress)
  }

  private func verifiedBytes(_ progress: [String: [String]], manifest: Manifest) -> UInt64 {
    manifest.files.reduce(0) { total, spec in
      total + (progress[spec.path] ?? []).indices.reduce(0) { subtotal, index in
        subtotal + min(spec.chunkSizeBytes, spec.byteCount - spec.chunkSizeBytes * UInt64(index))
      }
    }
  }

  private func completeProgress(_ manifest: Manifest) -> [String: [String]] {
    Dictionary(uniqueKeysWithValues: manifest.files.map { ($0.path, $0.chunkSha256) })
  }

  private func writeRecord(
    _ manifest: Manifest,
    state: String,
    bytesComplete: UInt64,
    reasonCode: String,
    progress: [String: [String]],
    activationGeneration: UInt64 = 0
  ) throws {
    try writeAtomic(Record(
      schemaVersion: "maina.model-pack-lifecycle-record.v1", packId: Self.packID,
      packVersion: manifest.packVersion, manifestSha256: manifest.manifestSha256,
      platform: Self.platformName, activationGeneration: activationGeneration, state: state,
      bytesComplete: bytesComplete, bytesTotal: manifest.bytesTotal, reasonCode: reasonCode,
      verifiedChunks: progress
    ), to: recordURL(manifest.manifestSha256))
  }

  private func fail(_ manifest: Manifest, state: String, reason: String, progress: [String: [String]]) throws {
    try writeRecord(manifest, state: state, bytesComplete: verifiedBytes(progress, manifest: manifest), reasonCode: reason, progress: progress)
    try? fileManager.removeItem(at: writerURL)
    try fsyncDirectory(root)
  }

  private func requireWriter(_ manifest: Manifest) throws {
    guard let writer: Writer = try readExact(writerURL, keys: writerKeys),
      validSHA(writer.manifestSha256), writer.manifestSha256 == manifest.manifestSha256,
      writer.platform == Self.platformName
    else { throw failure("MODEL_PACK_WRITER_IDENTITY_MISMATCH") }
  }

  private func requireRecord(_ manifest: Manifest, states: Set<String>) throws -> Record {
    guard let record = try readRecord(manifest.manifestSha256), record.manifestSha256 == manifest.manifestSha256,
      record.packVersion == manifest.packVersion, record.bytesTotal == manifest.bytesTotal,
      record.platform == Self.platformName, states.contains(record.state)
    else { throw failure("LIFECYCLE_TRANSITION_INVALID") }
    return record
  }

  private func readRecord(_ manifestSHA: String) throws -> Record? {
    guard let record: Record = try readExact(recordURL(manifestSHA), keys: recordKeys) else { return nil }
    guard record.schemaVersion == "maina.model-pack-lifecycle-record.v1", record.packId == Self.packID,
      record.platform == Self.platformName, validID(record.packVersion), validSHA(record.manifestSha256),
      lifecycleStates.contains(record.state), record.bytesTotal > 0, record.bytesComplete <= record.bytesTotal,
      validID(record.reasonCode), record.verifiedChunks.keys.allSatisfy(safeRelativePath),
      record.verifiedChunks.values.flatMap({ $0 }).allSatisfy(validSHA)
    else { throw failure("MODEL_PACK_RECORD_INVALID") }
    return record
  }

  private func readManifest(_ directory: URL) throws -> Manifest? {
    let url = directory.appendingPathComponent("manifest.json")
    guard fileManager.fileExists(atPath: url.path), try regularFile(url), try fileSize(url) <= 1_000_000 else { return nil }
    return try parseManifest(String(contentsOf: url, encoding: .utf8))
  }

  private func validPointer(_ pointer: Pointer) -> Bool {
    pointer.packId == Self.packID && validID(pointer.packVersion) && validSHA(pointer.manifestSha256)
      && pointer.platform == Self.platformName && pointer.activationGeneration > 0
      && pointer.runtimeVersion == Self.runtimeVersion
  }

  private func enumerateFiles(_ directory: URL) throws -> [String] {
    guard try regularDirectory(directory), let enumerator = fileManager.enumerator(
      at: directory,
      includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey],
      options: [],
      errorHandler: { _, _ in false }
    ) else { throw failure("MANIFEST_PATH_INVALID") }
    var values: [String] = []
    for case let file as URL in enumerator {
      let resource = try file.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey])
      if resource.isDirectory == true { continue }
      guard resource.isRegularFile == true, resource.isSymbolicLink != true else { throw failure("MANIFEST_PATH_INVALID") }
      values.append(String(file.path.dropFirst(directory.path.count + 1)))
    }
    return values
  }

  private func safeChild(_ parent: URL, _ relative: String) throws -> URL {
    guard safeRelativePath(relative) else { throw failure("MANIFEST_PATH_INVALID") }
    let child = parent.appendingPathComponent(relative).standardizedFileURL
    guard child.path.hasPrefix(parent.standardizedFileURL.path + "/") else { throw failure("MANIFEST_PATH_INVALID") }
    return child
  }

  private func regularFile(_ url: URL) throws -> Bool {
    let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
    return values.isRegularFile == true && values.isSymbolicLink != true && url.resolvingSymlinksInPath() == url.standardizedFileURL
  }

  private func regularDirectory(_ url: URL) throws -> Bool {
    let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
    return values.isDirectory == true && values.isSymbolicLink != true && url.resolvingSymlinksInPath() == url.standardizedFileURL
  }

  private func fileSize(_ url: URL) throws -> UInt64 {
    guard let value = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, value >= 0 else {
      throw failure("MODEL_PACK_STORAGE_INVALID")
    }
    return UInt64(value)
  }

  private func chunkHashes(_ url: URL, chunkSize: UInt64) throws -> [String] {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var hashes: [String] = []
    while true {
      var remaining = chunkSize
      var consumed: UInt64 = 0
      var hasher = SHA256()
      while remaining > 0 {
        let data = try handle.read(upToCount: Int(min(remaining, 1024 * 1024))) ?? Data()
        if data.isEmpty { break }
        hasher.update(data: data)
        consumed += UInt64(data.count)
        remaining -= UInt64(data.count)
      }
      if consumed == 0 { break }
      hashes.append(hasher.finalize().map { String(format: "%02x", $0) }.joined())
      if consumed < chunkSize { break }
    }
    return hashes
  }

  private func sha256(_ url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var hasher = SHA256()
    while true {
      let data = try handle.read(upToCount: 1024 * 1024) ?? Data()
      if data.isEmpty { break }
      hasher.update(data: data)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }

  private func sha256(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  private func writeAtomic<T: Encodable>(_ value: T, to url: URL) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    try writeDataAtomic(try encoder.encode(value), to: url)
  }

  private func writeDataAtomic(_ data: Data, to url: URL) throws {
    try ensureDirectory(url.deletingLastPathComponent())
    try data.write(to: url, options: [.atomic])
    try fsyncFile(url)
    try fsyncDirectory(url.deletingLastPathComponent())
  }

  private func readExact<T: Decodable>(_ url: URL, keys: Set<String>) throws -> T? {
    guard fileManager.fileExists(atPath: url.path) else { return nil }
    guard try regularFile(url) else { throw failure("MODEL_PACK_RECORD_INVALID") }
    let data = try Data(contentsOf: url)
    guard data.count <= 1_000_000,
      let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { throw failure("MODEL_PACK_RECORD_INVALID") }
    try exactKeys(object, expected: keys, code: "MODEL_PACK_RECORD_INVALID")
    return try JSONDecoder().decode(T.self, from: data)
  }

  private func retainedRollbackBytes() throws -> UInt64 {
    guard let pointer: Pointer = try readExact(readyPointer, keys: pointerKeys), validPointer(pointer),
      let manifest = try? parseManifest(String(contentsOf: packDirectory(pointer.manifestSha256).appendingPathComponent("manifest.json"), encoding: .utf8))
    else { return 0 }
    return manifest.bytesTotal
  }

  /**
   * A process can die after the staged directory is renamed but before the
   * ready record and pointer are both durable. The writer identity makes that
   * partial promotion discoverable. Reconciliation never guesses success: it
   * restores the prior exact pointer (or removes the incomplete first pointer),
   * records failed_smoke, and leaves all pack bytes retained for audit/cleanup.
   */
  private func reconcileInterruptedPromotion() throws {
    guard let writer: Writer = try readExact(writerURL, keys: writerKeys),
      validSHA(writer.manifestSha256), writer.platform == Self.platformName,
      let record = try readRecord(writer.manifestSha256)
    else { return }
    let current: Pointer? = try readExact(readyPointer, keys: pointerKeys)
    let currentMatches = current.map {
      validPointer($0) && $0.manifestSha256 == writer.manifestSha256
        && (record.state != "ready" || $0.activationGeneration == record.activationGeneration)
    } ?? false
    let previous: Pointer? = try readExact(previousPointer, keys: pointerKeys)
    let previousValid = previous.map(validPointer) ?? false
    let action = MainaModelPackLifecyclePolicy.interruptedPromotionAction(
      recordState: record.state,
      readyPointsToWriter: currentMatches,
      previousPointerValid: previousValid
    )
    if action == "complete_success_cleanup" {
      try fileManager.removeItem(at: writerURL)
      try fsyncDirectory(root)
      return
    }
    guard action != "none",
      let manifest = try readManifest(packDirectory(writer.manifestSha256))
    else { return }
    if action == "rollback_to_previous", let previous {
      try writeAtomic(previous, to: readyPointer)
    } else if action == "invalidate_first_activation" {
      try fileManager.removeItem(at: readyPointer)
      try fsyncDirectory(root)
    }
    try writeRecord(
      manifest, state: "failed_smoke", bytesComplete: manifest.bytesTotal,
      reasonCode: "PROMOTION_INTERRUPTED_ROLLED_BACK", progress: completeProgress(manifest),
      activationGeneration: record.activationGeneration
    )
    try fileManager.removeItem(at: writerURL)
    try fsyncDirectory(root)
  }

  private func availableBytes() throws -> UInt64 {
    let values = try root.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
    return UInt64(max(0, values.volumeAvailableCapacityForImportantUsage ?? 0))
  }

  private func ensureDirectories() throws {
    try ensureDirectory(root)
    for child in [stagingRoot, packsRoot, recordsRoot, readersRoot, resultsRoot] { try ensureDirectory(child) }
  }

  private func ensureDirectory(_ url: URL) throws {
    if !fileManager.fileExists(atPath: url.path) {
      try fileManager.createDirectory(at: url, withIntermediateDirectories: true)
    }
    guard try regularDirectory(url) else { throw failure("MODEL_PACK_STORAGE_INVALID") }
  }

  private func withWriterLock<T>(_ body: () throws -> T) throws -> T {
    try ensureDirectories()
    let descriptor = open(lockURL.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else { throw failure("MODEL_PACK_LOCK_FAILED") }
    defer { close(descriptor) }
    guard flock(descriptor, LOCK_EX) == 0 else { throw failure("MODEL_PACK_LOCK_FAILED") }
    defer { flock(descriptor, LOCK_UN) }
    return try body()
  }

  private func fsyncFile(_ url: URL) throws {
    let descriptor = open(url.path, O_RDONLY)
    guard descriptor >= 0 else { throw failure("MODEL_PACK_DURABILITY_FAILED") }
    defer { close(descriptor) }
    guard Darwin.fsync(descriptor) == 0 else { throw failure("MODEL_PACK_DURABILITY_FAILED") }
  }

  private func fsyncDirectory(_ url: URL) throws {
    let descriptor = open(url.path, O_RDONLY)
    guard descriptor >= 0 else { throw failure("MODEL_PACK_DURABILITY_FAILED") }
    defer { close(descriptor) }
    guard Darwin.fsync(descriptor) == 0 else { throw failure("MODEL_PACK_DURABILITY_FAILED") }
  }

  private func publicStatus(_ manifest: Manifest, state: String, bytes: UInt64, reason: String) -> PublicStatus {
    .init(packVersion: manifest.packVersion, state: state, bytesComplete: bytes, bytesTotal: manifest.bytesTotal, reasonCode: reason, platformCompatible: true)
  }

  private var stagingRoot: URL { root.appendingPathComponent("staging", isDirectory: true) }
  private var packsRoot: URL { root.appendingPathComponent("packs", isDirectory: true) }
  private var recordsRoot: URL { root.appendingPathComponent("records", isDirectory: true) }
  private var readersRoot: URL { root.appendingPathComponent("readers", isDirectory: true) }
  private var resultsRoot: URL { root.appendingPathComponent("results", isDirectory: true) }
  private var readyPointer: URL { root.appendingPathComponent("ready.json") }
  private var previousPointer: URL { root.appendingPathComponent("previous-ready.json") }
  private var writerURL: URL { root.appendingPathComponent("writer.json") }
  private var lockURL: URL { root.appendingPathComponent("writer.lock") }
  private func stagingDirectory(_ sha: String) -> URL { stagingRoot.appendingPathComponent(sha, isDirectory: true) }
  private func packDirectory(_ sha: String) -> URL { packsRoot.appendingPathComponent(sha, isDirectory: true) }
  private func recordURL(_ sha: String) -> URL { recordsRoot.appendingPathComponent("\(sha).json") }

  private static let packID = "qwen3-asr-0.6b-int8"
  private static let platformName = "ios"
  private static let runtimeVersion = "sherpa-onnx-1.13.4-ios-no-tts"
  private static let runtimeSHA256 = "d8baaa925248e8e8ad23870208cdaf3d093623e6733aede2c23862f30c5aac62"
  private let requiredFiles: [String: UInt64] = [
    "conv_frontend.onnx": 44_148_281, "encoder.int8.onnx": 182_491_662,
    "decoder.int8.onnx": 755_914_231, "tokenizer/vocab.json": 2_776_833,
    "tokenizer/merges.txt": 1_671_853, "tokenizer/tokenizer_config.json": 12_487,
  ]
  private let manifestKeys = Set(["schemaVersion", "packId", "packVersion", "engineId", "formatVersion", "files", "platforms", "smokeInputSha256", "manifestSha256"])
  private let fileKeys = Set(["path", "byteCount", "sha256", "chunkSizeBytes", "chunkSha256"])
  private let platformKeys = Set(["osFamily", "minOsVersion", "architectures", "runtimeVersion", "runtimeSha256", "smokeExpectedTextSha256"])
  private let pointerKeys = Set(["packId", "packVersion", "manifestSha256", "platform", "activationGeneration", "runtimeVersion"])
  private let writerKeys = Set(["manifestSha256", "platform"])
  private let recordKeys = Set(["schemaVersion", "packId", "packVersion", "manifestSha256", "platform", "activationGeneration", "state", "bytesComplete", "bytesTotal", "reasonCode", "verifiedChunks"])
  private let lifecycleStates = Set([
    "unavailable", "downloading", "verifying", "staged", "smoke_testing", "ready",
    "failed_download", "failed_verification", "failed_smoke", "rollback_pending",
  ])

  private func exactKeys(_ value: [String: Any], expected: Set<String>, code: String) throws {
    guard Set(value.keys) == expected else { throw failure(code) }
  }

  private func canonicalJSON(_ value: Any) throws -> String {
    if value is NSNull { return "null" }
    if let string = value as? String {
      let encoded = String(data: try JSONSerialization.data(withJSONObject: [string]), encoding: .utf8)!
      return String(encoded.dropFirst().dropLast())
    }
    if let number = value as? NSNumber {
      if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue ? "true" : "false" }
      guard number.doubleValue.rounded() == number.doubleValue else { throw failure("MANIFEST_INVALID") }
      return number.stringValue
    }
    if let array = value as? [Any] { return "[" + (try array.map(canonicalJSON)).joined(separator: ",") + "]" }
    if let object = value as? [String: Any] {
      return "{" + (try object.keys.sorted().map { key in
        let json = String(data: try JSONSerialization.data(withJSONObject: [key]), encoding: .utf8)!
        let encoded = String(json.dropFirst().dropLast())
        return "\(encoded):\(try canonicalJSON(object[key]!))"
      }).joined(separator: ",") + "}"
    }
    throw failure("MANIFEST_INVALID")
  }

  private func validSHA(_ value: String) -> Bool { value.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil }
  private func validID(_ value: String) -> Bool { value.range(of: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$", options: .regularExpression) != nil }
  private func validVersion(_ value: String) -> Bool { value.range(of: "^[0-9]+(?:\\.[0-9]+){0,2}$", options: .regularExpression) != nil }
  private func safeRelativePath(_ value: String) -> Bool {
    !value.isEmpty && !value.hasPrefix("/") && !value.contains("\\")
      && value.split(separator: "/", omittingEmptySubsequences: false).allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
  }

  private static func osVersion() -> String {
    let value = ProcessInfo.processInfo.operatingSystemVersion
    return "\(value.majorVersion).\(value.minorVersion).\(value.patchVersion)"
  }

  private func compareVersions(_ left: String, _ right: String) -> Int {
    let a = left.split(separator: ".").compactMap { Int($0) }
    let b = right.split(separator: ".").compactMap { Int($0) }
    for index in 0..<max(a.count, b.count) {
      let comparison = (a.indices.contains(index) ? a[index] : 0) - (b.indices.contains(index) ? b[index] : 0)
      if comparison != 0 { return comparison > 0 ? 1 : -1 }
    }
    return 0
  }

  private func failure(_ code: String) -> NSError {
    NSError(domain: "MainaModelPackLifecycle", code: 1, userInfo: [NSLocalizedDescriptionKey: code])
  }
}
