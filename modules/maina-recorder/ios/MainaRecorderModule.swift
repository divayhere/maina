import AVFAudio
import ExpoModulesCore
import UIKit

/**
 * iOS boundary for Maina's recorder.
 *
 * Android has a service-owned recorder and Accessibility trigger. iOS deliberately
 * has different lifecycle rules, so this module starts as a capability boundary
 * instead of pretending that Android's foreground-service or key interception
 * behavior exists on Apple devices. Native capture is added only after the iPhone
 * feasibility gates in docs/IOS_FEASIBILITY_PLAN.md pass.
 */
public final class MainaRecorderModule: Module {
  private let capture = MainaIOSNativeAudioCapture.shared
  private let qwen = MainaQwenAsr.shared
  private let modelPacks = MainaModelPackLifecycle.shared
  private let continuedProcessing = MainaIOSContinuedProcessing.shared
  private let pipelineWake = MainaIOSPipelineWake.shared
  private lazy var nativePostProcessing: MainaNativePostProcessingCoordinator? = {
    guard let store = try? MainaNativePostProcessingStore(
      databaseURL: MainaNativePostProcessingStore.defaultDatabaseURL()
    ) else { return nil }
    return MainaNativePostProcessingCoordinator(
      store: store,
      transcribe: { [weak self] claim, completion in
        guard let self else { completion(.failure(.runtimeInterrupted)); return }
        self.qwen.transcribe(
          uri: claim.audioURI,
          startMs: Double(claim.audioStartMs),
          endMs: Double(claim.audioEndMs)
        ) { result in
          switch result {
          case .success(let payload):
            completion(MainaNativePostProcessingQwenAdapter.recognition(payload: payload, claim: claim))
          case .failure(let error):
            completion(.failure(MainaNativePostProcessingQwenAdapter.failure(error)))
          }
        }
      },
      releaseRecognizer: { [weak self] in self?.qwen.release() },
      onChanged: { [weak self] event in self?.sendEvent("onNativePostProcessingChanged", event) }
    )
  }()

  public func definition() -> ModuleDefinition {
    Name("MainaRecorder")

    Events(
      "onAudioRouteChanged",
      "onNativePostProcessingChanged",
      "onPipelineWakeRequested",
      "onIOSPostProcessingDeferralRequested"
    )

    OnCreate {
      self.capture.configure { [weak self] event in
        self?.sendEvent("onAudioRouteChanged", event)
      }
      self.pipelineWake.configure { [weak self] event in
        self?.sendEvent("onPipelineWakeRequested", event)
      }
      self.continuedProcessing.configure { [weak self] event in
        self?.sendEvent("onIOSPostProcessingDeferralRequested", event)
      }
    }

    Function("getIOSFeasibilityStatus") { () -> [String: Any] in
      let audioModes = Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String] ?? []
      return [
        "platform": "ios",
        "systemVersion": UIDevice.current.systemVersion,
        "audioBackgroundModeConfigured": audioModes.contains("audio"),
        "microphonePermission": Self.microphonePermissionLabel(),
        "hardwareTrigger": "unsupported-generic-hid",
      ]
    }

    // Staging qualification hook. The value exists only when the process is
    // launched explicitly from the USB test harness with an environment flag;
    // normal user launches always return nil and cannot enter automation.
    Function("getIOSAutomationScenario") { () -> String? in
      ProcessInfo.processInfo.environment["MAINA_AUTOMATION_SCENARIO"]
    }

    AsyncFunction("requestIOSMicrophonePermission") { (promise: Promise) in
      AVAudioSession.sharedInstance().requestRecordPermission { granted in
        promise.resolve(granted)
      }
    }

    Function("startForegroundSession") { true }
    Function("stopForegroundSession") { }
    Function("setCaptureState") { (_: String) in }
    AsyncFunction("startNativeCapture") { (meetingId: String, directory: String, _: String, chunkDurationMs: Int, meetingStartedAt: Double) in
      let result = try self.capture.start(
        meetingId: meetingId,
        directoryValue: directory,
        chunkDurationMs: chunkDurationMs,
        meetingStartedAt: meetingStartedAt
      )
      self.nativePostProcessing?.setRecordingActive(true)
      return result
    }
    AsyncFunction("pauseNativeCapture") { try self.capture.pause() }
    AsyncFunction("resumeNativeCapture") { try self.capture.resume() }
    AsyncFunction("stopNativeCapture") {
      let result = self.capture.stop()
      self.nativePostProcessing?.setRecordingActive(false)
      return result
    }
    AsyncFunction("abortNativeCapture") {
      let result = self.capture.abort()
      self.nativePostProcessing?.setRecordingActive(false)
      return result
    }
    Function("getNativeCaptureStatus") { self.capture.status() }
    // `status()` serializes against the capture queue. Exposing an async form
    // keeps that wait off React Native's JavaScript thread while AVAudioSession
    // is opening, rotating, or recovering an input route.
    AsyncFunction("getNativeCaptureStatusAsync") { self.capture.status() }
    AsyncFunction("inspectNativeCaptureDirectory") { (directory: String, recoverPartials: Bool) in
      self.capture.inspectDirectory(directory, recoverPartials: recoverPartials)
    }
    AsyncFunction("deleteNativeCaptureDirectory") { (directory: String) in
      self.capture.deleteDirectory(directory)
    }
    AsyncFunction("getPcmWavDurationsMs") { (uris: [String]) in self.capture.durations(uris) }
    Function("getAudioInputs") { self.capture.inputs() }
    Function("repairWavFiles") { (_: [String]) in 0 }

    Function("getQwenAsrStatus") { self.qwen.status() }
    AsyncFunction("getNativeModelPackLifecycleStatus") {
      try self.modelPacks.status().dictionary
    }
    AsyncFunction("beginNativeModelPackAcquisition") {
      (manifestJson: String, partialOverheadBytes: Int64, safetyMarginBytes: Int64) in
      guard partialOverheadBytes >= 0, safetyMarginBytes >= 0 else {
        throw Self.bridgeFailure("model_pack_storage_input_invalid")
      }
      return try self.modelPacks.begin(
        manifestJSON: manifestJson,
        partialOverheadBytes: UInt64(partialOverheadBytes),
        safetyMarginBytes: UInt64(safetyMarginBytes)
      ).dictionary
    }
    AsyncFunction("stageNativeModelPackChunk") {
      (manifestJson: String, relativePath: String, chunkIndex: Int, sourceUri: String) in
      try self.modelPacks.stageChunk(
        manifestJSON: manifestJson,
        relativePath: relativePath,
        chunkIndex: chunkIndex,
        sourceURI: sourceUri
      ).dictionary
    }
    AsyncFunction("verifyAndPromoteNativeModelPack") {
      (manifestJson: String, smokeInputUri: String) in
      _ = try self.modelPacks.verifyStaged(manifestJSON: manifestJson)
      let evidence = try self.qwen.smoke(
        root: self.modelPacks.smokeRoot(manifestJSON: manifestJson),
        uri: smokeInputUri
      )
      return try self.modelPacks.promote(manifestJSON: manifestJson, evidence: evidence).dictionary
    }
    AsyncFunction("transcribeWithQwen") { (uri: String, startMs: Double, endMs: Double, promise: Promise) in
      self.qwen.transcribe(uri: uri, startMs: startMs, endMs: endMs) { result in
        switch result {
        case .success(let payload): promise.resolve(payload)
        case .failure(let error): promise.reject(error)
        }
      }
    }
    AsyncFunction("releaseQwenAsr") { self.qwen.release() }
    Function("beginIOSContinuedProcessing") { (jobId: String, title: String, subtitle: String, totalUnits: Int) in
      self.continuedProcessing.begin(jobId: jobId, title: title, subtitle: subtitle, totalUnits: totalUnits)
    }
    Function("bindIOSContinuedProcessingRun") { (requestId: String, meetingId: String, asrGeneration: Int) in
      self.continuedProcessing.bindRun(
        identifier: requestId,
        meetingId: meetingId,
        asrGeneration: asrGeneration
      )
    }
    Function("updateIOSContinuedProcessing") { (requestId: String, completedUnits: Int, totalUnits: Int, subtitle: String?) in
      self.continuedProcessing.update(
        identifier: requestId,
        completedUnits: completedUnits,
        totalUnits: totalUnits,
        subtitle: subtitle
      )
    }
    Function("finishIOSContinuedProcessing") { (requestId: String, success: Bool) in
      self.continuedProcessing.finish(identifier: requestId, success: success)
    }
    Function("acknowledgeIOSContinuedProcessingDeferral") {
      (requestId: String, meetingId: String, asrGeneration: Int) in
      self.continuedProcessing.acknowledgeDeferral(
        identifier: requestId,
        meetingId: meetingId,
        asrGeneration: asrGeneration
      )
    }
    Function("isIOSContinuedProcessingActive") { (requestId: String, meetingId: String) in
      self.continuedProcessing.isActive(identifier: requestId, meetingId: meetingId)
        || self.pipelineWake.hasActiveExecution()
    }
    AsyncFunction("schedulePipelineWake") {
      (
        generation: Int,
        requiresNetwork: Bool,
        notBeforeAt: Double,
        scheduleRevision: Int,
        previousWorkId: String?,
        previousNotBeforeAt: Double?,
        previousScheduleRevision: Int?,
        schedulerProtocolVersion: Int,
        promise: Promise
      ) in
      self.pipelineWake.schedule(
        generation: generation,
        requiresNetwork: requiresNetwork,
        notBeforeAt: Int64(notBeforeAt),
        scheduleRevision: scheduleRevision,
        previousWorkId: previousWorkId,
        previousNotBeforeAt: previousNotBeforeAt.map(Int64.init),
        previousScheduleRevision: previousScheduleRevision,
        schedulerProtocolVersion: schedulerProtocolVersion
      ) { result in
        promise.resolve(result)
      }
    }
    AsyncFunction("claimPendingPipelineWake") {
      self.pipelineWake.claimPending()
    }
    AsyncFunction("completePipelineWake") { (attemptToken: String, succeeded: Bool) in
      ["completed": self.pipelineWake.complete(attemptToken: attemptToken, succeeded: succeeded)]
    }
    AsyncFunction("isPipelineWakeAttemptActive") { (attemptToken: String) in
      ["active": self.pipelineWake.isActive(attemptToken: attemptToken)]
    }
    makePrepareIOSNativePostProcessingAudioDefinition()
    makeStartIOSNativePostProcessingDefinition()
    makeReadIOSNativePostProcessingResultDefinition()
    makeAcknowledgeIOSNativePostProcessingResultDefinition()
    makeReleaseIOSNativePostProcessingAsrDefinition()
    Function("startNativePostProcessing") { (_: [String: Any]) in
      throw NSError(domain: "MainaRecorder", code: 1002, userInfo: [NSLocalizedDescriptionKey: "The iOS local ASR runtime has not been installed yet."])
    }
    Function("readNativePostProcessingResult") { (_: String) -> [String: Any]? in nil }
    Function("acknowledgeNativePostProcessingResult") { (_: String, _: String) in ["acknowledged": false] }
  }

  private func makePrepareIOSNativePostProcessingAudioDefinition() -> any AnyDefinition {
    AsyncFunction("prepareIOSNativePostProcessingAudio") { (meetingId: String, directory: String) -> [String: Any] in
      do {
        try Self.requireExactCaptureDirectory(meetingId: meetingId, directory: directory)
        let inspection = self.capture.inspectDirectory(directory, recoverPartials: false)
        guard let finalized = inspection["finalizedUris"] as? [String],
          let partials = inspection["partialUris"] as? [String], partials.isEmpty
        else { throw Self.bridgeFailure("audio_finalization_incomplete") }
        let segments = try MainaNativePostProcessingAudioPlanner.loadSegments(
          uris: finalized,
          durations: self.capture.durations(finalized)
        )
        return [
          "schemaVersion": "maina.native-post-processing-audio.v1",
          "audioFingerprintSha256": try MainaNativePostProcessingAudioPlanner.fingerprint(segments),
          "audioDurationMs": segments.reduce(0) { $0 + $1.durationMs },
          "segmentCount": segments.count,
        ]
      } catch {
        throw Self.bridgeFailure("native_audio_plan_unavailable")
      }
    }
  }

  private func makeStartIOSNativePostProcessingDefinition() -> any AnyDefinition {
    AsyncFunction("startIOSNativePostProcessing") { (requestValue: [String: Any], directory: String, promise: Promise) in
      self.startIOSNativePostProcessing(requestValue: requestValue, directory: directory, promise: promise)
    }
  }

  private func startIOSNativePostProcessing(
    requestValue: [String: Any],
    directory: String,
    promise: Promise
  ) {
    do {
      let request = try MainaNativePostProcessingBridgeCodec.start(requestValue)
      try Self.requireExactCaptureDirectory(meetingId: request.meetingId, directory: directory)
      let inspection = capture.inspectDirectory(directory, recoverPartials: false)
      guard let finalized = inspection["finalizedUris"] as? [String],
        let partials = inspection["partialUris"] as? [String], partials.isEmpty
      else { throw Self.bridgeFailure("audio_finalization_incomplete") }
      let segments = try MainaNativePostProcessingAudioPlanner.loadSegments(
        uris: finalized,
        durations: capture.durations(finalized)
      )
      let start = try MainaNativePostProcessingAudioPlanner.makeStart(
        request: request,
        segments: segments,
        modelVersion: "1",
        runtimeVersion: "sherpa-onnx-1.13.4-ios-no-tts",
        createdAtMs: Int64(Date().timeIntervalSince1970 * 1_000)
      )
      guard let coordinator = nativePostProcessing else {
        throw Self.bridgeFailure("native_store_unavailable")
      }
      coordinator.start(start) { result in
        switch result {
        case .success(let value):
          let payload: [String: Any] = [
            "requested": true,
            "resumed": value.resumed,
            "state": value.state,
            "firstIncompleteWindowKey": value.firstIncompleteWindowKey ?? NSNull(),
          ]
          promise.resolve(payload)
        case .failure:
          promise.reject(Self.bridgeFailure("native_post_processing_start_failed"))
        }
      }
    } catch {
      promise.reject(Self.bridgeFailure("native_post_processing_start_failed"))
    }
  }

  private func makeReadIOSNativePostProcessingResultDefinition() -> any AnyDefinition {
    AsyncFunction("readIOSNativePostProcessingResult") { (requestValue: [String: Any], promise: Promise) in
      do {
        let request = try MainaNativePostProcessingBridgeCodec.read(requestValue)
        guard let coordinator = self.nativePostProcessing else {
          throw Self.bridgeFailure("native_store_unavailable")
        }
        let result = try coordinator.readResult(
          ownerUserId: request.ownerUserId,
          meetingId: request.meetingId,
          runId: request.runId,
          generation: request.generation
        )
        promise.resolve(result ?? NSNull())
      } catch {
        promise.reject(Self.bridgeFailure("native_post_processing_read_failed"))
      }
    }
  }

  private func makeAcknowledgeIOSNativePostProcessingResultDefinition() -> any AnyDefinition {
    AsyncFunction("acknowledgeIOSNativePostProcessingResult") { (fenceValue: [String: Any]) -> [String: Any] in
      do {
        let fence = try MainaNativePostProcessingBridgeCodec.acknowledge(fenceValue)
        guard let coordinator = self.nativePostProcessing else {
          throw Self.bridgeFailure("native_store_unavailable")
        }
        return ["acknowledged": try coordinator.acknowledge(fence)]
      } catch {
        throw Self.bridgeFailure("native_post_processing_acknowledgement_failed")
      }
    }
  }

  private func makeReleaseIOSNativePostProcessingAsrDefinition() -> any AnyDefinition {
    AsyncFunction("releaseIOSNativePostProcessingAsr") { (requestValue: [String: Any]) -> [String: Any] in
      do {
        let request = try MainaNativePostProcessingBridgeCodec.release(requestValue)
        guard let coordinator = self.nativePostProcessing else {
          throw Self.bridgeFailure("native_store_unavailable")
        }
        return ["released": try coordinator.releaseAsr(
          runtimeOwnerToken: request.runtimeOwnerToken,
          generation: request.generation
        )]
      } catch {
        throw Self.bridgeFailure("native_post_processing_release_failed")
      }
    }
  }

  private static func microphonePermissionLabel() -> String {
    switch AVAudioSession.sharedInstance().recordPermission {
    case .granted:
      return "granted"
    case .denied:
      return "denied"
    case .undetermined:
      return "undetermined"
    @unknown default:
      return "unknown"
    }
  }

  private static func requireExactCaptureDirectory(meetingId: String, directory: String) throws {
    guard meetingId.range(
      of: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
      options: .regularExpression
    ) != nil, let supplied = URL(string: directory), supplied.isFileURL else {
      throw bridgeFailure("capture_directory_invalid")
    }
    let expected = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("rec-\(meetingId)", isDirectory: true)
    guard supplied.standardizedFileURL.resolvingSymlinksInPath().path
      == expected.standardizedFileURL.resolvingSymlinksInPath().path
    else { throw bridgeFailure("capture_directory_invalid") }
  }

  private static func bridgeFailure(_ code: String) -> NSError {
    NSError(domain: "MainaNativePostProcessing", code: 2_001, userInfo: [NSLocalizedDescriptionKey: code])
  }
}
