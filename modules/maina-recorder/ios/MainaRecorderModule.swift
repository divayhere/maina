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
  public func definition() -> ModuleDefinition {
    Name("MainaRecorder")

    Events("onAudioRouteChanged", "onNativePostProcessingChanged")

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
