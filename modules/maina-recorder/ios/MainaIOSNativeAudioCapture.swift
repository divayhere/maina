import AVFAudio
import CallKit
import Foundation
import UIKit

/**
 * iOS capture owner for Maina.
 *
 * Recording deliberately lives below React Native. An active AVAudioSession
 * with the `audio` background mode keeps capture alive when the screen locks;
 * a journal and independently closed WAV chunks make every durable boundary
 * recoverable after an interruption or later launch. This class does not make
 * impossible promises: a phone call or physical input switch can cause a
 * short measured gap, but it never turns that event into a second meeting.
 */
final class MainaIOSNativeAudioCapture: NSObject, AVAudioRecorderDelegate, CXCallObserverDelegate {
  static let shared = MainaIOSNativeAudioCapture()

  private enum CaptureState: String {
    case idle, starting, recording, pausing, paused, resuming, finalizing, error
  }

  private let queue = DispatchQueue(label: "com.divay.maina.ios.capture")
  private let audioSession = AVAudioSession.sharedInstance()
  private var recorder: AVAudioRecorder?
  private var chunkTimer: DispatchSourceTimer?
  private var meterTimer: DispatchSourceTimer?
  private var routeObserver: NSObjectProtocol?
  private var interruptionObserver: NSObjectProtocol?
  private var mediaServicesResetObserver: NSObjectProtocol?
  private var appActiveObserver: NSObjectProtocol?
  private let callObserver = CXCallObserver()
  private var state: CaptureState = .idle
  private var meetingId: String?
  private var directory: URL?
  private var chunkDurationMs: Int = 10 * 60_000
  private var chunkIndex = 0
  private var currentPartialURL: URL?
  private var meetingStartedAt: Double?
  private var startedUptime: TimeInterval?
  private var lastProgressAtMs: Double?
  private var lastError: String?
  private var routeRestartCount = 0
  private var routeRecoveryActive = false
  private var lastRouteChangeAtMs: Double?
  private var captureGapMs: Double = 0
  private var recoveryStartedUptime: TimeInterval?
  private var rmsDbfs: Float = -90
  private var peakDbfs: Float = -90
  private var deliberatelyPaused = false
  private var interrupted = false
  private var communicationActive = false
  private var recoveryGeneration = 0
  private var recoveryBackgroundTask: UIBackgroundTaskIdentifier = .invalid
  private var recoveryAwaitingPublicSignal = false
  private var recoveryReasonCode: String?
  private var platformHoldCount = 0
  private var recoverySignalCount = 0
  private var lastStorageCheckUptime: TimeInterval = 0
  private var freeStorageBytes: Int64 = 0
  private var onRouteChanged: (([String: Any]) -> Void)?

  private static let storageReserveBytes: Int64 = 256 * 1_024 * 1_024
  // A call can release microphone priority several seconds after its UI ends.
  // Keep the first retry immediate, then stay within one bounded UIKit
  // background-time assertion instead of requiring the owner to reopen Maina.
  private static let recoveryDelaysMs = [0, 250, 500, 1_000, 2_000, 3_000]
  private static let recoveryRetryBudgetMs: Double = 30_000

  private override init() {
    super.init()
    callObserver.setDelegate(self, queue: queue)
    communicationActive = callObserver.calls.contains(where: { !$0.hasEnded })
  }

  func configure(onRouteChanged: @escaping ([String: Any]) -> Void) {
    queue.async { self.onRouteChanged = onRouteChanged }
  }

  func start(
    meetingId: String,
    directoryValue: String,
    chunkDurationMs: Int,
    meetingStartedAt: Double
  ) throws -> [String: Any] {
    try queue.sync {
      guard state == .idle else { throw CaptureError.invalidState("A Maina recording is already active.") }
      let observerCallActive = refreshCommunicationActiveFromObserver()
      guard MainaIOSCallRecoveryPolicy.manualResumeAllowed(
        communicationActive: communicationActive,
        observerCallActive: observerCallActive
      ) else {
        throw CaptureError.invalidState("The microphone is currently owned by a call.")
      }
      let directory = Self.fileURL(directoryValue)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

      self.state = .starting
      self.meetingId = meetingId
      self.directory = directory
      self.chunkDurationMs = max(30_000, min(chunkDurationMs, 10 * 60_000))
      self.chunkIndex = Self.nextChunkIndex(in: directory)
      self.meetingStartedAt = meetingStartedAt
      self.startedUptime = ProcessInfo.processInfo.systemUptime
      self.lastError = nil
      self.routeRestartCount = 0
      self.routeRecoveryActive = false
      self.captureGapMs = 0
      self.rmsDbfs = -90
      self.peakDbfs = -90
      self.deliberatelyPaused = false
      self.interrupted = false
      self.recoveryAwaitingPublicSignal = false
      self.recoveryReasonCode = nil
      self.platformHoldCount = 0
      self.recoverySignalCount = 0
      self.recoveryGeneration += 1
      self.lastStorageCheckUptime = 0
      self.freeStorageBytes = Self.availableStorageBytes(at: directory)

      do {
        try configureAudioSession()
        installNotificationsIfNeeded()
        appendJournal("started", fields: [
          "meetingId": meetingId,
          "chunkDurationMs": self.chunkDurationMs,
          "route": routeDescription(),
        ])
        try openAndStartChunk(reason: "initial")
        state = .recording
        startTimers()
        return ["requested": true]
      } catch {
        lastError = error.localizedDescription
        appendJournal("capture-start-failed", fields: ["error": lastError ?? "unknown"])
        tearDownSession()
        resetIdle()
        throw error
      }
    }
  }

  func pause() throws -> [String: Any] {
    try queue.sync {
      guard state == .recording else { throw CaptureError.invalidState("Maina is not recording.") }
      cancelSystemRecovery(reason: "manual-pause")
      state = .pausing
      deliberatelyPaused = true
      closeActiveChunk(reason: "pause", preserve: true)
      // A resumed recorder must never reuse and overwrite the just-finalized
      // chunk. Keep every durable pause boundary as its own audio file.
      chunkIndex += 1
      stopTimers()
      state = .paused
      appendJournal("paused", fields: [:])
      return ["requested": true]
    }
  }

  func resume() throws -> [String: Any] {
    try queue.sync {
      guard state == .paused else { throw CaptureError.invalidState("Maina is not paused.") }
      let observerCallActive = refreshCommunicationActiveFromObserver()
      switch MainaIOSCallRecoveryPolicy.manualResumeAction(
        interrupted: interrupted,
        deliberatelyPaused: deliberatelyPaused,
        communicationActive: communicationActive,
        observerCallActive: observerCallActive
      ) {
      case .queueSystemRecovery:
        recoverySignalCount += 1
        recoveryAwaitingPublicSignal = true
        recoveryReasonCode = "manual-system-recovery-requested"
        appendJournal("manual-system-recovery-requested", fields: [
          "generation": recoveryGeneration,
        ])
        scheduleRecovery(reason: "manual-resume-request")
        return [
          "requested": true,
          "waiting": state != .recording,
          "recoveryReasonCode": recoveryReasonCode ?? "system-recovery-pending",
        ]
      case .rejectCommunicationActive:
        throw CaptureError.invalidState("The microphone is still owned by a call or system interruption.")
      case .resumeDeliberatePause:
        break
      }
      cancelSystemRecovery(reason: "manual-resume")
      state = .resuming
      deliberatelyPaused = false
      do {
        try configureAudioSession()
        try openAndStartChunk(reason: "resume")
        state = .recording
        interrupted = false
        startTimers()
        appendJournal("resumed", fields: [:])
        return ["requested": true]
      } catch {
        state = .paused
        interrupted = true
        throw error
      }
    }
  }

  func stop() -> [String: Any] {
    queue.sync {
      guard state != .idle else { return ["requested": true] }
      cancelSystemRecovery(reason: "stop")
      state = .finalizing
      closeActiveChunk(reason: "stop", preserve: true)
      appendJournal("stopped", fields: [
        "routeRestartCount": routeRestartCount,
        "captureGapMs": captureGapMs,
      ])
      tearDownSession()
      resetIdle()
      return ["requested": true]
    }
  }

  func abort() -> [String: Any] {
    queue.sync {
      guard state != .idle else { return ["requested": true] }
      cancelSystemRecovery(reason: "abort")
      closeActiveChunk(reason: "abort", preserve: false)
      tearDownSession()
      resetIdle()
      return ["requested": true]
    }
  }

  func status() -> [String: Any] {
    queue.sync {
      var result: [String: Any] = [
        "state": state.rawValue,
        "chunkIndex": chunkIndex,
        "bytesWritten": currentPartialURL.flatMap { Self.fileBytes(at: $0) } ?? 0,
        "lastProgressAtMs": lastProgressAtMs ?? 0,
        "lastError": lastError ?? NSNull(),
        "routeRestartCount": routeRestartCount,
        "routeRecoveryActive": routeRecoveryActive,
        "lastRouteChangeElapsedMs": lastRouteChangeAtMs ?? 0,
        "captureGapMs": captureGapMs,
        "rmsDbfs": rmsDbfs,
        "peakDbfs": peakDbfs,
        "freeStorageBytes": freeStorageBytes,
        "storageReserveBytes": Self.storageReserveBytes,
        "recoveryAwaitingPublicSignal": recoveryAwaitingPublicSignal,
        "recoveryReasonCode": recoveryReasonCode ?? NSNull(),
        "platformHoldCount": platformHoldCount,
        "recoverySignalCount": recoverySignalCount,
      ]
      if let meetingId { result["meetingId"] = meetingId }
      if state == .paused {
        if deliberatelyPaused {
          result["pauseReason"] = "manual"
        } else if interrupted {
          result["pauseReason"] = "communication"
        } else {
          result["pauseReason"] = NSNull()
        }
      } else {
        result["pauseReason"] = NSNull()
      }
      if let startedUptime { result["startedElapsedMs"] = startedUptime * 1_000 }
      let route = audioSession.currentRoute.inputs.first
      result["routedDeviceId"] = route?.uid.hashValue ?? 0
      result["routedDeviceType"] = route?.portType.rawValue ?? "unknown"
      result["routedDeviceName"] = route?.portName ?? "No microphone"
      result["sourceMode"] = "voice_recognition"
      return result
    }
  }

  func inspectDirectory(_ directoryValue: String, recoverPartials: Bool) -> [String: Any] {
    let directory = Self.fileURL(directoryValue)
    var recovered = 0
    var invalid = 0
    let files = (try? FileManager.default.contentsOfDirectory(
      at: directory,
      includingPropertiesForKeys: [.fileSizeKey],
      options: [.skipsHiddenFiles]
    )) ?? []

    for partial in files where partial.lastPathComponent.range(of: #"^capture-\d+\.partial\.wav$"#, options: .regularExpression) != nil {
      guard recoverPartials else { continue }
      let final = partial.deletingLastPathComponent()
        .appendingPathComponent(partial.lastPathComponent.replacingOccurrences(of: ".partial.wav", with: ".wav"))
      guard !FileManager.default.fileExists(atPath: final.path) else { invalid += 1; continue }
      do {
        // AVAudioRecorder writes PCM continuously but updates the RIFF/data
        // lengths only during an orderly stop. After a process kill the audio
        // payload is durable while both header lengths can still be zero.
        // Repair those two bounded fields before asking AVFoundation to read it.
        guard Self.repairInterruptedPcmWav(at: partial), Self.pcmWavDataBytes(at: partial) > 0 else {
          try? FileManager.default.removeItem(at: partial)
          invalid += 1
          continue
        }
        let readable = try AVAudioFile(forReading: partial)
        guard readable.length > 0 else {
          try? FileManager.default.removeItem(at: partial)
          invalid += 1
          continue
        }
        try FileManager.default.moveItem(at: partial, to: final)
        recovered += 1
      } catch {
        invalid += 1
      }
    }

    let refreshed = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
    let finalized = refreshed
      .filter { $0.lastPathComponent.range(of: #"^capture-\d+\.wav$"#, options: .regularExpression) != nil }
      .sorted { $0.lastPathComponent < $1.lastPathComponent }
      .map(\.absoluteString)
    let partials = refreshed
      .filter { $0.lastPathComponent.range(of: #"^capture-\d+\.partial\.wav$"#, options: .regularExpression) != nil }
      .sorted { $0.lastPathComponent < $1.lastPathComponent }
      .map(\.absoluteString)
    let journal = directory.appendingPathComponent("capture-journal.jsonl")
    return [
      "finalizedUris": finalized,
      "partialUris": partials,
      "recoveredCount": recovered,
      "invalidPartialCount": invalid,
      "journalUri": FileManager.default.fileExists(atPath: journal.path) ? journal.absoluteString : NSNull(),
    ]
  }

  func deleteDirectory(_ directoryValue: String) -> Bool {
    let directory = Self.fileURL(directoryValue)
    guard FileManager.default.fileExists(atPath: directory.path) else { return true }
    do {
      try FileManager.default.removeItem(at: directory)
      return !FileManager.default.fileExists(atPath: directory.path)
    } catch {
      return false
    }
  }

  func durations(_ uris: [String]) -> [String: Any] {
    Dictionary(uniqueKeysWithValues: uris.map { uri in
      let url = Self.fileURL(uri)
      // Also repairs a malformed file moved by an older staging build. This is
      // idempotent for a healthy WAV and lets upgrades recover existing audio.
      _ = Self.repairInterruptedPcmWav(at: url)
      let duration: Double?
      do {
        let file = try AVAudioFile(forReading: url)
        duration = file.length > 0 && file.fileFormat.sampleRate > 0
          ? Double(file.length) * 1_000 / file.fileFormat.sampleRate
          : Self.pcmWavDurationMs(at: url)
      } catch {
        duration = Self.pcmWavDurationMs(at: url)
      }
      return (uri, duration ?? NSNull())
    })
  }

  func inputs() -> [[String: Any]] {
    queue.sync {
      // `currentRoute.inputs` is empty while the audio session is idle. Settings
      // and Diagnostics still need to show the microphones iOS can select, so
      // fall back to `availableInputs` until a recording owns the active route.
      let inputs = audioSession.currentRoute.inputs.isEmpty
        ? (audioSession.availableInputs ?? [])
        : audioSession.currentRoute.inputs
      return inputs.map { input in
        ["id": input.uid.hashValue, "name": input.portName, "type": input.portType.rawValue]
      }
    }
  }

  private func configureAudioSession() throws {
    var options: AVAudioSession.CategoryOptions = []
    options.insert(.allowBluetoothHFP)
    try audioSession.setCategory(.record, mode: .measurement, options: options)
    // Physical route removal still has to be journaled and recovered below,
    // but iOS 17+ lets an active capture prefer continuity over an automatic
    // route-disconnect interruption. This is a preference, not a guarantee.
    if #available(iOS 17.0, *) {
      try? audioSession.setPrefersInterruptionOnRouteDisconnect(false)
    }
    try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
  }

  private func openAndStartChunk(reason: String) throws {
    guard let directory else { throw CaptureError.invalidState("Maina has no capture directory.") }
    let partial = directory.appendingPathComponent(String(format: "capture-%05d.partial.wav", chunkIndex))
    try? FileManager.default.removeItem(at: partial)
    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatLinearPCM,
      AVSampleRateKey: 16_000,
      AVNumberOfChannelsKey: 1,
      AVLinearPCMBitDepthKey: 16,
      AVLinearPCMIsBigEndianKey: false,
      AVLinearPCMIsFloatKey: false,
    ]
    let next = try AVAudioRecorder(url: partial, settings: settings)
    next.delegate = self
    next.isMeteringEnabled = true
    guard next.prepareToRecord() else {
      try? FileManager.default.removeItem(at: partial)
      throw CaptureError.startFailed("iPhone could not begin microphone capture.")
    }
    // The monotonic file identity and recoverable PCM header exist durably
    // before microphone ownership is requested. A failed start can therefore
    // delete only a provably empty partial without exposing Recording state.
    if let handle = try? FileHandle(forWritingTo: partial) {
      try? handle.synchronize()
      try? handle.close()
    }
    appendJournal("chunk-allocated", fields: ["index": chunkIndex, "reason": reason, "file": partial.lastPathComponent])
    guard next.record(), next.isRecording else {
      try? FileManager.default.removeItem(at: partial)
      throw CaptureError.startFailed("iPhone could not begin microphone capture.")
    }
    recorder = next
    currentPartialURL = partial
    lastProgressAtMs = Date().timeIntervalSince1970 * 1_000
    appendJournal("chunk-opened", fields: ["index": chunkIndex, "reason": reason, "file": partial.lastPathComponent])
  }

  private func closeActiveChunk(reason: String, preserve: Bool) {
    guard let active = recorder else { return }
    active.updateMeters()
    active.stop()
    recorder = nil
    let partial = currentPartialURL
    currentPartialURL = nil
    guard let partial else { return }
    let bytes = Self.fileBytes(at: partial)
    let payloadBytes = Self.pcmWavDataBytes(at: partial)
    guard preserve, payloadBytes > 0 else {
      try? FileManager.default.removeItem(at: partial)
      appendJournal("chunk-discarded", fields: ["index": chunkIndex, "reason": reason])
      return
    }
    let final = partial.deletingLastPathComponent()
      .appendingPathComponent(partial.lastPathComponent.replacingOccurrences(of: ".partial.wav", with: ".wav"))
    do {
      // Never replace an existing finalized chunk. A collision means the
      // source file remains as a recoverable partial rather than silently
      // overwriting earlier meeting audio.
      guard !FileManager.default.fileExists(atPath: final.path) else {
        lastError = "Saved audio name conflict for chunk \(chunkIndex)."
        appendJournal("chunk-finalization-conflict", fields: ["index": chunkIndex, "file": partial.lastPathComponent])
        return
      }
      try FileManager.default.moveItem(at: partial, to: final)
      let duration = (try? AVAudioFile(forReading: final)).flatMap { file in
        file.fileFormat.sampleRate > 0 ? Double(file.length) * 1_000 / file.fileFormat.sampleRate : nil
      } ?? 0
      appendJournal("chunk-finalized", fields: [
        "index": chunkIndex,
        "file": final.lastPathComponent,
        "bytes": bytes,
        "durationMs": duration,
        "reason": reason,
      ])
    } catch {
      lastError = "Could not finalize saved audio: \(error.localizedDescription)"
      appendJournal("chunk-finalization-failed", fields: ["index": chunkIndex, "reason": reason, "error": lastError ?? "unknown"])
    }
  }

  private func startTimers() {
    stopTimers()
    let meter = DispatchSource.makeTimerSource(queue: queue)
    meter.schedule(deadline: .now(), repeating: .milliseconds(250))
    meter.setEventHandler { [weak self] in self?.sampleMeters() }
    meter.resume()
    meterTimer = meter

    let boundary = DispatchSource.makeTimerSource(queue: queue)
    boundary.schedule(deadline: .now() + .milliseconds(chunkDurationMs))
    boundary.setEventHandler { [weak self] in self?.rotateAtBoundary() }
    boundary.resume()
    chunkTimer = boundary
  }

  private func stopTimers() {
    chunkTimer?.setEventHandler {}
    chunkTimer?.cancel()
    chunkTimer = nil
    meterTimer?.setEventHandler {}
    meterTimer?.cancel()
    meterTimer = nil
  }

  private func sampleMeters() {
    guard state == .recording, let recorder, recorder.isRecording else { return }
    recorder.updateMeters()
    rmsDbfs = recorder.averagePower(forChannel: 0)
    peakDbfs = recorder.peakPower(forChannel: 0)
    lastProgressAtMs = Date().timeIntervalSince1970 * 1_000
    let uptime = ProcessInfo.processInfo.systemUptime
    if uptime - lastStorageCheckUptime >= 5 {
      lastStorageCheckUptime = uptime
      guard let directory else { return }
      freeStorageBytes = Self.availableStorageBytes(at: directory)
      if freeStorageBytes > 0 && freeStorageBytes < Self.storageReserveBytes {
        lastError = "Recording stopped safely because this iPhone is almost out of storage."
        appendJournal("storage-reserve-reached", fields: [
          "freeStorageBytes": freeStorageBytes,
          "reserveBytes": Self.storageReserveBytes,
        ])
        closeActiveChunk(reason: "storage-reserve", preserve: true)
        tearDownSession()
        state = .error
      }
    }
  }

  private func rotateAtBoundary() {
    guard state == .recording else { return }
    closeActiveChunk(reason: "duration-boundary", preserve: true)
    chunkIndex += 1
    do {
      try openAndStartChunk(reason: "duration-boundary")
      startTimers()
    } catch {
      fail("chunk rotation failed", error: error)
    }
  }

  private func installNotificationsIfNeeded() {
    if routeObserver == nil {
      routeObserver = NotificationCenter.default.addObserver(
        forName: AVAudioSession.routeChangeNotification,
        object: audioSession,
        queue: nil
      ) { [weak self] notification in
        self?.queue.async { self?.handleRouteChange(notification) }
      }
    }
    if interruptionObserver == nil {
      interruptionObserver = NotificationCenter.default.addObserver(
        forName: AVAudioSession.interruptionNotification,
        object: audioSession,
        queue: nil
      ) { [weak self] notification in
        self?.queue.async { self?.handleInterruption(notification) }
      }
    }
    if mediaServicesResetObserver == nil {
      mediaServicesResetObserver = NotificationCenter.default.addObserver(
        forName: AVAudioSession.mediaServicesWereResetNotification,
        object: audioSession,
        queue: nil
      ) { [weak self] _ in
        self?.queue.async { self?.handleMediaServicesReset() }
      }
    }
    if appActiveObserver == nil {
      appActiveObserver = NotificationCenter.default.addObserver(
        forName: UIApplication.didBecomeActiveNotification,
        object: nil,
        queue: nil
      ) { [weak self] _ in
        self?.queue.async { self?.recoverWhenAppBecomesActive() }
      }
    }
  }

  private func handleRouteChange(_ notification: Notification) {
    let reasonValue = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 0
    let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue)
    lastRouteChangeAtMs = Date().timeIntervalSince1970 * 1_000

    // Call teardown can produce a route notification even when the matching
    // interruption-ended notification is delayed. Treat it as another bounded
    // recovery signal while preserving the same meeting and closed chunks.
    if state == .paused, interrupted, !deliberatelyPaused {
      recoverySignalCount += 1
      recoveryReasonCode = "route-change-signal"
      appendJournal("route-change-while-interrupted", fields: [
        "reason": String(describing: reason ?? .unknown),
        "route": routeDescription(),
      ])
      let observerCallActive = refreshCommunicationActiveFromObserver()
      guard MainaIOSCallRecoveryPolicy.manualResumeAllowed(
        communicationActive: communicationActive,
        observerCallActive: observerCallActive
      ) else {
        appendJournal("capture-recovery-vetoed-by-call", fields: ["signal": "route-change"])
        return
      }
      // Configuring our own session can emit a category-change notification.
      // Never let that reset an in-flight backoff chain to attempt zero.
      guard !routeRecoveryActive else { return }
      scheduleRecovery(reason: "route-resumption-recovery")
      return
    }

    guard state == .recording, !interrupted, !routeRecoveryActive else { return }

    // setCategory/setActive can emit category/override notifications for our
    // own session. Restarting a healthy recorder for those notifications can
    // create a recovery loop. Only hardware/input topology changes require a
    // new durable WAV chunk; otherwise recover only if capture actually died.
    let requiresChunkRestart: Bool
    switch reason {
    case .newDeviceAvailable, .oldDeviceUnavailable, .noSuitableRouteForCategory:
      requiresChunkRestart = true
    default:
      requiresChunkRestart = recorder?.isRecording != true
    }
    guard requiresChunkRestart else {
      appendJournal("route-change-observed", fields: [
        "reason": String(describing: reason ?? .unknown),
        "route": routeDescription(),
      ])
      onRouteChanged?(routeEvent(change: "active-route"))
      return
    }

    appendJournal("route-change", fields: ["reason": String(describing: reason ?? .unknown), "route": routeDescription()])
    onRouteChanged?(routeEvent(change: "active-route"))
    beginSystemPause(reason: "route-change")
    scheduleRecovery(reason: "route-recovery")
  }

  private func handleInterruption(_ notification: Notification) {
    let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt ?? 0
    guard let type = AVAudioSession.InterruptionType(rawValue: rawType) else { return }
    switch type {
    case .began:
      communicationActive = communicationActive || callObserver.calls.contains(where: { !$0.hasEnded })
      if communicationActive { suspendRecoveryForActiveCall(reason: "interruption-began") }
      beginSystemPause(reason: "system-interruption")
      appendJournal("interruption-began", fields: ["communicationActive": communicationActive])
      // Do not spend a finite UIKit assertion or retry budget while a call
      // still owns the microphone. End/route/CallKit signals coalesce later.
    case .ended:
      let optionsValue = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
      let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)
      let observerCallActive = refreshCommunicationActiveFromObserver()
      guard interrupted else { return }
      guard !deliberatelyPaused else {
        interrupted = false
        appendJournal("interruption-ended", fields: ["resumed": false])
        return
      }
      recoverySignalCount += 1
      recoveryReasonCode = "interruption-ended-signal"
      appendJournal("interruption-ended", fields: [
        "systemSuggestedResume": options.contains(.shouldResume),
        "communicationActive": observerCallActive,
      ])
      if !observerCallActive { scheduleRecovery(reason: "interruption-recovery") }
    @unknown default:
      break
    }
  }

  private func handleMediaServicesReset() {
    guard state != .idle, !deliberatelyPaused else { return }
    appendJournal("media-services-reset", fields: [:])
    beginSystemPause(reason: "media-services-reset")
    scheduleRecovery(reason: "media-services-reset-recovery")
  }

  private func recoverWhenAppBecomesActive() {
    let observerCallActive = refreshCommunicationActiveFromObserver()
    guard state == .paused, interrupted, !deliberatelyPaused, !observerCallActive else { return }
    recoverySignalCount += 1
    recoveryReasonCode = "app-active-wake"
    appendJournal("foreground-recovery-check", fields: [:])
    scheduleRecovery(reason: "foreground-recovery")
  }

  /**
   * AVAudioSession can remain unavailable briefly after a phone/VoIP call or
   * route handoff. Retrying on the capture queue preserves the same meeting and
   * every already-closed WAV chunk. Exhaustion leaves the meeting safely paused
   * instead of converting a temporary session race into terminal data loss.
   */
  private func scheduleRecovery(reason: String, attempt: Int = 0) {
    let observerCallActive = refreshCommunicationActiveFromObserver()
    let action = MainaIOSCallRecoveryPolicy.action(
      paused: state == .paused,
      interrupted: interrupted,
      manuallyPaused: deliberatelyPaused,
      communicationActive: communicationActive,
      observerCallActive: observerCallActive,
      recoveryLoopActive: routeRecoveryActive && attempt == 0
    )
    guard action == .start || attempt > 0 else {
      if action == .coalesce {
        appendJournal("capture-recovery-signal-coalesced", fields: ["reason": reason])
      } else if action == .vetoCommunication {
        appendJournal("capture-recovery-vetoed-by-call", fields: ["signal": reason])
      }
      return
    }
    if attempt == 0 {
      recoveryAwaitingPublicSignal = false
      recoveryReasonCode = reason
      beginRecoveryBackgroundTaskIfNeeded(reason: reason)
    }
    let generation = recoveryGeneration
    let boundedAttempt = min(attempt, Self.recoveryDelaysMs.count - 1)
    let delayMs = Self.recoveryDelaysMs[boundedAttempt]
    routeRecoveryActive = true
    queue.asyncAfter(deadline: .now() + .milliseconds(delayMs)) { [weak self] in
      guard let self,
        self.recoveryGeneration == generation,
        self.state == .paused,
        self.interrupted,
        !self.deliberatelyPaused
      else { return }
      let observerCallActive = self.refreshCommunicationActiveFromObserver()
      if observerCallActive {
        self.suspendRecoveryForActiveCall(reason: "call-became-active")
        return
      }
      do {
        try self.configureAudioSession()
        try self.openAndStartChunk(reason: reason)
        self.state = .recording
        self.interrupted = false
        self.routeRecoveryActive = false
        self.recoveryAwaitingPublicSignal = false
        self.recoveryReasonCode = "recovered"
        self.routeRestartCount += 1
        self.lastError = nil
        let gap = max(0, (ProcessInfo.processInfo.systemUptime - (self.recoveryStartedUptime ?? ProcessInfo.processInfo.systemUptime)) * 1_000)
        self.captureGapMs += gap
        self.startTimers()
        self.appendJournal("capture-recovered", fields: [
          "reason": reason,
          "attempt": attempt + 1,
          "gapMs": gap,
          "routeRestartCount": self.routeRestartCount,
          "route": self.routeDescription(),
        ])
        self.endRecoveryBackgroundTask()
        self.onRouteChanged?(self.routeEvent(change: "active-route"))
      } catch {
        let nsError = error as NSError
        let disposition = MainaIOSCallRecoveryPolicy.failureDisposition(
          domain: nsError.domain,
          code: nsError.code
        )
        if disposition == .temporaryPlatformHold {
          self.platformHoldCount += 1
          self.recoveryReasonCode = "cannot-interrupt-others"
          self.lastError = "iPhone is still releasing the microphone. Maina will continue this meeting on the next permitted wake."
        }
        self.appendJournal("capture-recovery-attempt-failed", fields: [
          "reason": reason,
          "attempt": attempt + 1,
          "errorDomain": nsError.domain,
          "errorCode": nsError.code,
          "failureDisposition": disposition == .temporaryPlatformHold ? "temporary-platform-hold" : "other",
        ])
        let nextAttempt = attempt + 1
        let recoveryElapsedMs = max(
          0,
          (ProcessInfo.processInfo.systemUptime -
            (self.recoveryStartedUptime ?? ProcessInfo.processInfo.systemUptime)) * 1_000
        )
        if self.canContinueRecoveryWatcher() && MainaIOSCallRecoveryPolicy.recoveryMayRetry(
          elapsedMs: recoveryElapsedMs,
          budgetMs: Self.recoveryRetryBudgetMs
        ) {
          // After the initial fast sequence, retry at a capped three-second
          // cadence until UIKit's actual background-time assertion approaches
          // expiration. Signals coalesce into this one generation/loop.
          self.scheduleRecovery(
            reason: reason,
            attempt: min(nextAttempt, Self.recoveryDelaysMs.count - 1)
          )
        } else {
          self.routeRecoveryActive = false
          self.recoveryAwaitingPublicSignal = MainaIOSCallRecoveryPolicy.shouldRetainPendingGeneration(
            disposition: disposition,
            stopped: self.state == .idle || self.state == .finalizing,
            manuallyPaused: self.deliberatelyPaused
          )
          if !self.recoveryAwaitingPublicSignal {
            self.lastError = "Microphone recovery is paused safely. Reopen Maina to continue this recording."
          }
          self.appendJournal("capture-recovery-deferred", fields: [
            "reason": reason,
            "recoveryReasonCode": self.recoveryReasonCode ?? "other",
            "awaitingPublicSignal": self.recoveryAwaitingPublicSignal,
          ])
          self.endRecoveryBackgroundTask()
        }
      }
    }
  }

  private func canContinueRecoveryWatcher() -> Bool {
    if refreshCommunicationActiveFromObserver() { return false }
    if UIApplication.shared.applicationState == .active { return true }
    guard recoveryBackgroundTask != .invalid else { return false }
    return UIApplication.shared.backgroundTimeRemaining > 4
  }

  private func beginRecoveryBackgroundTaskIfNeeded(reason: String) {
    guard recoveryBackgroundTask == .invalid else { return }
    recoveryBackgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Maina microphone recovery") { [weak self] in
      self?.expireRecoveryBackgroundTaskSynchronously(reason: reason)
    }
    appendJournal("capture-recovery-background-time-began", fields: [
      "reason": reason,
      "granted": recoveryBackgroundTask != .invalid,
    ])
  }

  private func expireRecoveryBackgroundTaskSynchronously(reason: String) {
    let task: UIBackgroundTaskIdentifier = queue.sync {
      let current = recoveryBackgroundTask
      guard current != .invalid else { return .invalid }
      let temporaryPlatformHold = recoveryReasonCode == "cannot-interrupt-others"
      recoveryAwaitingPublicSignal = temporaryPlatformHold && state == .paused && interrupted && !deliberatelyPaused
      appendJournal("capture-recovery-background-time-expired", fields: [
        "reason": reason,
        "awaitingPublicSignal": recoveryAwaitingPublicSignal,
      ])
      routeRecoveryActive = false
      if !recoveryAwaitingPublicSignal {
        lastError = "Microphone recovery is paused safely. Reopen Maina to continue this recording."
      }
      // Revoke any timer owned by the exhausted UIKit assertion while keeping
      // exactly one pending recovery generation for the next public signal.
      recoveryGeneration += 1
      recoveryBackgroundTask = .invalid
      return current
    }
    if task != .invalid {
      UIApplication.shared.endBackgroundTask(task)
    }
  }

  private func endRecoveryBackgroundTask() {
    let task = recoveryBackgroundTask
    guard task != .invalid else { return }
    recoveryBackgroundTask = .invalid
    UIApplication.shared.endBackgroundTask(task)
  }

  private func tearDownSession() {
    stopTimers()
    endRecoveryBackgroundTask()
    do { try audioSession.setActive(false, options: .notifyOthersOnDeactivation) } catch { /* best effort */ }
  }

  private func resetIdle() {
    recoveryGeneration += 1
    state = .idle
    meetingId = nil
    directory = nil
    currentPartialURL = nil
    meetingStartedAt = nil
    startedUptime = nil
    lastProgressAtMs = nil
    deliberatelyPaused = false
    interrupted = false
    routeRecoveryActive = false
    recoveryAwaitingPublicSignal = false
    recoveryReasonCode = nil
    endRecoveryBackgroundTask()
  }

  private func beginSystemPause(reason: String) {
    guard state == .recording else {
      if state == .paused, !deliberatelyPaused { interrupted = true }
      return
    }
    recoveryGeneration += 1
    recoveryStartedUptime = ProcessInfo.processInfo.systemUptime
    routeRecoveryActive = false
    recoveryAwaitingPublicSignal = false
    recoveryReasonCode = reason
    endRecoveryBackgroundTask()
    interrupted = true
    stopTimers()
    closeActiveChunk(reason: reason, preserve: true)
    chunkIndex += 1
    state = .paused
    appendJournal("system-paused", fields: ["reason": reason, "generation": recoveryGeneration])
  }

  private func cancelSystemRecovery(reason: String) {
    recoveryGeneration += 1
    routeRecoveryActive = false
    recoveryAwaitingPublicSignal = false
    recoveryReasonCode = "cancelled"
    endRecoveryBackgroundTask()
    appendJournal("capture-recovery-cancelled", fields: ["reason": reason, "generation": recoveryGeneration])
  }

  private func suspendRecoveryForActiveCall(reason: String) {
    routeRecoveryActive = false
    endRecoveryBackgroundTask()
    appendJournal("capture-recovery-suspended-for-call", fields: [
      "reason": reason,
      "generation": recoveryGeneration,
    ])
  }

  @discardableResult
  private func refreshCommunicationActiveFromObserver() -> Bool {
    let observerCallActive = callObserver.calls.contains(where: { !$0.hasEnded })
    communicationActive = MainaIOSCallRecoveryPolicy.refreshedCommunicationActive(
      cached: communicationActive,
      observerCallActive: observerCallActive
    )
    return observerCallActive
  }

  func callObserver(_ callObserver: CXCallObserver, callChanged call: CXCall) {
    let active = MainaIOSCallRecoveryPolicy.refreshedCommunicationActive(
      cached: communicationActive,
      observerCallActive: callObserver.calls.contains(where: { !$0.hasEnded })
    )
    guard communicationActive != active else { return }
    communicationActive = active
    appendJournal("call-state-changed", fields: ["active": active])
    if active {
      suspendRecoveryForActiveCall(reason: "call-observer-active")
      beginSystemPause(reason: "call-observer")
      return
    }
    guard state == .paused, interrupted, !deliberatelyPaused else { return }
    recoverySignalCount += 1
    recoveryReasonCode = "call-ended-signal"
    scheduleRecovery(reason: "call-observer-ended")
  }

  private func fail(_ message: String, error: Error) {
    lastError = "\(message): \(error.localizedDescription)"
    appendJournal("capture-error", fields: ["error": lastError ?? message])
    closeActiveChunk(reason: "error", preserve: true)
    tearDownSession()
    state = .error
  }

  private func appendJournal(_ event: String, fields: [String: Any]) {
    guard let directory else { return }
    var payload: [String: Any] = [
      "id": UUID().uuidString,
      "event": event,
      "wallTimeMs": Date().timeIntervalSince1970 * 1_000,
      "elapsedMs": ProcessInfo.processInfo.systemUptime * 1_000,
    ]
    fields.forEach { payload[$0.key] = $0.value }
    guard JSONSerialization.isValidJSONObject(payload),
      let line = try? JSONSerialization.data(withJSONObject: payload),
      let handle = try? FileHandle(forWritingTo: directory.appendingPathComponent("capture-journal.jsonl"))
    else {
      if let line = try? JSONSerialization.data(withJSONObject: payload) {
        FileManager.default.createFile(atPath: directory.appendingPathComponent("capture-journal.jsonl").path, contents: line + Data([10]))
      }
      return
    }
    defer { try? handle.close() }
    do {
      try handle.seekToEnd()
      handle.write(line)
      handle.write(Data([10]))
      try handle.synchronize()
    } catch { /* journal is supplemental; capture must continue */ }
  }

  private func routeDescription() -> String {
    audioSession.currentRoute.inputs.map { "\($0.portType.rawValue):\($0.portName)" }.joined(separator: ",")
  }

  private func routeEvent(change: String) -> [String: Any] {
    let input = audioSession.currentRoute.inputs.first
    return [
      "change": change,
      "deviceId": input?.uid.hashValue ?? 0,
      "deviceType": input?.portType.rawValue ?? "unknown",
      "deviceName": input?.portName ?? "No microphone",
      "occurredAt": Date().timeIntervalSince1970 * 1_000,
    ]
  }

  private static func fileURL(_ value: String) -> URL {
    if let url = URL(string: value), url.isFileURL { return url }
    return URL(fileURLWithPath: value)
  }

  private static func nextChunkIndex(in directory: URL) -> Int {
    let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
    let indexes = files.compactMap { url -> Int? in
      let pattern = #"^capture-(\d+)\.(?:partial\.)?wav$"#
      guard let match = url.lastPathComponent.range(of: pattern, options: .regularExpression) else { return nil }
      let matched = String(url.lastPathComponent[match])
      let digits = matched.replacingOccurrences(of: #"\D"#, with: "", options: .regularExpression)
      return Int(digits)
    }
    return (indexes.max() ?? -1) + 1
  }

  private static func fileBytes(at url: URL) -> Int64 {
    ((try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber)?.int64Value ?? 0
  }

  private static func availableStorageBytes(at url: URL) -> Int64 {
    let values = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
    return values?.volumeAvailableCapacityForImportantUsage ?? 0
  }

  /** Return the PCM payload length from Maina's RIFF/WAV file.
   *
   * AVAudioRecorder reserves a 4 KiB header containing JUNK/FLLR chunks, so a
   * fixed 44-byte WAV assumption is incorrect. The `data` chunk is located by
   * walking RIFF chunk boundaries and, for an interrupted file whose declared
   * data length is still zero, the durable bytes after that header are used.
   */
  private static func pcmWavDataBytes(at url: URL) -> Int64 {
    guard let layout = pcmWavLayout(at: url) else { return 0 }
    return layout.payloadBytes
  }

  private static func pcmWavDurationMs(at url: URL) -> Double? {
    guard let layout = pcmWavLayout(at: url), layout.sampleRate > 0, layout.blockAlign > 0 else { return nil }
    let frames = Double(layout.payloadBytes) / Double(layout.blockAlign)
    return frames > 0 ? frames * 1_000 / Double(layout.sampleRate) : nil
  }

  /** Repair only the two size fields that an orderly AVAudioRecorder stop
   * normally finalizes. Existing audio bytes and format metadata are untouched.
   */
  private static func repairInterruptedPcmWav(at url: URL) -> Bool {
    guard let layout = pcmWavLayout(at: url), layout.payloadBytes > 0,
      layout.payloadBytes <= Int64(UInt32.max), layout.fileBytes >= 8,
      layout.fileBytes - 8 <= Int64(UInt32.max)
    else { return false }

    let expectedData = UInt32(layout.payloadBytes)
    let expectedRiff = UInt32(layout.fileBytes - 8)
    if layout.declaredDataBytes == expectedData && layout.declaredRiffBytes == expectedRiff { return true }

    guard let handle = try? FileHandle(forWritingTo: url) else { return false }
    defer { try? handle.close() }
    do {
      try handle.seek(toOffset: 4)
      handle.write(littleEndianData(expectedRiff))
      try handle.seek(toOffset: UInt64(layout.dataSizeOffset))
      handle.write(littleEndianData(expectedData))
      try handle.synchronize()
      return true
    } catch {
      return false
    }
  }

  private struct PcmWavLayout {
    let fileBytes: Int64
    let dataSizeOffset: Int
    let payloadBytes: Int64
    let declaredDataBytes: UInt32
    let declaredRiffBytes: UInt32
    let sampleRate: UInt32
    let blockAlign: UInt16
  }

  private static func pcmWavLayout(at url: URL) -> PcmWavLayout? {
    let fileBytes = Self.fileBytes(at: url)
    guard fileBytes >= 20, let handle = try? FileHandle(forReadingFrom: url) else { return nil }
    defer { try? handle.close() }
    let data: Data
    do {
      guard let prefix = try handle.read(upToCount: Int(min(fileBytes, 1_048_576))) else { return nil }
      data = prefix
    } catch {
      return nil
    }
    guard data.count >= 20,
      String(data: data[0..<4], encoding: .ascii) == "RIFF",
      String(data: data[8..<12], encoding: .ascii) == "WAVE",
      let declaredRiff = uint32LE(data, at: 4)
    else { return nil }

    var cursor = 12
    var sampleRate: UInt32 = 0
    var blockAlign: UInt16 = 0
    while cursor + 8 <= data.count {
      guard let size = uint32LE(data, at: cursor + 4) else { return nil }
      let id = String(data: data[cursor..<(cursor + 4)], encoding: .ascii)
      if id == "fmt ", cursor + 8 + Int(size) <= data.count, size >= 16 {
        sampleRate = uint32LE(data, at: cursor + 12) ?? 0
        blockAlign = uint16LE(data, at: cursor + 20) ?? 0
      }
      if id == "data" {
        let payloadOffset = cursor + 8
        let durablePayload = max(0, fileBytes - Int64(payloadOffset))
        return PcmWavLayout(
          fileBytes: fileBytes,
          dataSizeOffset: cursor + 4,
          payloadBytes: durablePayload,
          declaredDataBytes: size,
          declaredRiffBytes: declaredRiff,
          sampleRate: sampleRate,
          blockAlign: blockAlign
        )
      }
      let paddedSize = Int(size) + (Int(size) & 1)
      cursor += 8 + paddedSize
    }
    return nil
  }

  private static func uint16LE(_ data: Data, at offset: Int) -> UInt16? {
    guard offset >= 0, offset + 2 <= data.count else { return nil }
    return UInt16(data[offset]) | (UInt16(data[offset + 1]) << 8)
  }

  private static func uint32LE(_ data: Data, at offset: Int) -> UInt32? {
    guard offset >= 0, offset + 4 <= data.count else { return nil }
    return UInt32(data[offset])
      | (UInt32(data[offset + 1]) << 8)
      | (UInt32(data[offset + 2]) << 16)
      | (UInt32(data[offset + 3]) << 24)
  }

  private static func littleEndianData<T: FixedWidthInteger>(_ value: T) -> Data {
    var littleEndian = value.littleEndian
    return Data(bytes: &littleEndian, count: MemoryLayout<T>.size)
  }

  private enum CaptureError: LocalizedError {
    case invalidState(String)
    case startFailed(String)

    var errorDescription: String? {
      switch self {
      case let .invalidState(message), let .startFailed(message): return message
      }
    }
  }
}
