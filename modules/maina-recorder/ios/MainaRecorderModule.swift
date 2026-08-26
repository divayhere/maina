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

    AsyncFunction("requestIOSMicrophonePermission") { (promise: Promise) in
      AVAudioSession.sharedInstance().requestRecordPermission { granted in
        promise.resolve(granted)
      }
    }

    Function("startForegroundSession") { true }
    Function("stopForegroundSession") { }
    Function("setCaptureState") { (_: String) in }
    Function("startNativeCapture") { (meetingId: String, directory: String, _: String, chunkDurationMs: Int, meetingStartedAt: Double) in
      try self.capture.start(
        meetingId: meetingId,
        directoryValue: directory,
        chunkDurationMs: chunkDurationMs,
        meetingStartedAt: meetingStartedAt
      )
    }
    Function("pauseNativeCapture") { try self.capture.pause() }
    Function("resumeNativeCapture") { try self.capture.resume() }
    Function("stopNativeCapture") { self.capture.stop() }
    Function("abortNativeCapture") { self.capture.abort() }
    Function("getNativeCaptureStatus") { self.capture.status() }
    Function("inspectNativeCaptureDirectory") { (directory: String, recoverPartials: Bool) in
      self.capture.inspectDirectory(directory, recoverPartials: recoverPartials)
    }
    Function("deleteNativeCaptureDirectory") { (directory: String) in
      self.capture.deleteDirectory(directory)
    }
    Function("getPcmWavDurationsMs") { (uris: [String]) in self.capture.durations(uris) }
    Function("getAudioInputs") { self.capture.inputs() }
    Function("repairWavFiles") { (_: [String]) in 0 }

    // The iOS Qwen bridge is installed separately from capture. Returning an
    // explicit unavailable state keeps the meeting durable and prevents UI
    // code from pretending that transcript work has completed.
    Function("getQwenAsrStatus") {
      ["ready": false, "root": "", "reason": "The iOS local ASR runtime has not been installed yet."]
    }
    Function("transcribeWithQwen") { (_: String, _: Double, _: Double) in
      throw NSError(domain: "MainaRecorder", code: 1001, userInfo: [NSLocalizedDescriptionKey: "The iOS local ASR runtime has not been installed yet."])
    }
    Function("releaseQwenAsr") { }
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
