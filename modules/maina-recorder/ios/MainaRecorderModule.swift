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

  public func definition() -> ModuleDefinition {
    Name("MainaRecorder")

    Events("onAudioRouteChanged", "onNativePostProcessingChanged")

    OnCreate {
      self.capture.configure { [weak self] event in
        self?.sendEvent("onAudioRouteChanged", event)
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
      try self.capture.start(
        meetingId: meetingId,
        directoryValue: directory,
        chunkDurationMs: chunkDurationMs,
        meetingStartedAt: meetingStartedAt
      )
    }
    AsyncFunction("pauseNativeCapture") { try self.capture.pause() }
    AsyncFunction("resumeNativeCapture") { try self.capture.resume() }
    AsyncFunction("stopNativeCapture") { self.capture.stop() }
    AsyncFunction("abortNativeCapture") { self.capture.abort() }
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
    AsyncFunction("transcribeWithQwen") { (uri: String, startMs: Double, endMs: Double, promise: Promise) in
      self.qwen.transcribe(uri: uri, startMs: startMs, endMs: endMs) { result in
        switch result {
        case .success(let payload): promise.resolve(payload)
        case .failure(let error): promise.reject(error)
        }
      }
    }
    AsyncFunction("releaseQwenAsr") { self.qwen.release() }
    Function("startNativePostProcessing") { (_: [String: Any]) in
      throw NSError(domain: "MainaRecorder", code: 1002, userInfo: [NSLocalizedDescriptionKey: "The iOS local ASR runtime has not been installed yet."])
    }
    Function("readNativePostProcessingResult") { (_: String) -> [String: Any]? in nil }
    Function("acknowledgeNativePostProcessingResult") { (_: String, _: String) in ["acknowledged": false] }
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
}
