import AVFAudio
import Foundation

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
final class MainaIOSNativeAudioCapture: NSObject, AVAudioRecorderDelegate {
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
  private var onRouteChanged: (([String: Any]) -> Void)?

  private override init() {
    super.init()
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
      state = .resuming
      deliberatelyPaused = false
      try configureAudioSession()
      try openAndStartChunk(reason: "resume")
      state = .recording
      startTimers()
      appendJournal("resumed", fields: [:])
      return ["requested": true]
    }
  }

  func stop() -> [String: Any] {
    queue.sync {
      guard state != .idle else { return ["requested": true] }
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
      ]
      if let meetingId { result["meetingId"] = meetingId }
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
        _ = try AVAudioFile(forReading: partial)
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
      let duration: Double?
      do {
        let file = try AVAudioFile(forReading: Self.fileURL(uri))
        duration = file.length > 0 && file.fileFormat.sampleRate > 0
          ? Double(file.length) * 1_000 / file.fileFormat.sampleRate
          : nil
      } catch {
        duration = nil
      }
      return (uri, duration ?? NSNull())
    })
  }

  func inputs() -> [[String: Any]] {
    queue.sync {
      audioSession.currentRoute.inputs.enumerated().map { index, input in
        ["id": index, "name": input.portName, "type": input.portType.rawValue]
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
    guard next.prepareToRecord(), next.record() else {
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
    guard preserve, bytes > 44 else {
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
  }

  private func handleRouteChange(_ notification: Notification) {
    guard state == .recording, !interrupted, !routeRecoveryActive else { return }
    let reasonValue = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 0
    let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue)
    lastRouteChangeAtMs = Date().timeIntervalSince1970 * 1_000
    recoveryStartedUptime = ProcessInfo.processInfo.systemUptime
    routeRecoveryActive = true
    appendJournal("route-change", fields: ["reason": String(describing: reason ?? .unknown), "route": routeDescription()])
    onRouteChanged?(routeEvent(change: "active-route"))
    closeActiveChunk(reason: "route-change", preserve: true)
    chunkIndex += 1
    queue.asyncAfter(deadline: .now() + .milliseconds(350)) { [weak self] in
      guard let self, self.state == .recording, !self.interrupted else { return }
      do {
        try self.configureAudioSession()
        try self.openAndStartChunk(reason: "route-recovery")
        self.routeRestartCount += 1
        let gap = max(0, (ProcessInfo.processInfo.systemUptime - (self.recoveryStartedUptime ?? ProcessInfo.processInfo.systemUptime)) * 1_000)
        self.captureGapMs += gap
        self.routeRecoveryActive = false
        self.startTimers()
        self.appendJournal("route-recovered", fields: ["gapMs": gap, "routeRestartCount": self.routeRestartCount, "route": self.routeDescription()])
        self.onRouteChanged?(self.routeEvent(change: "active-route"))
      } catch {
        self.fail("Audio input could not recover after a route change", error: error)
      }
    }
  }

  private func handleInterruption(_ notification: Notification) {
    let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt ?? 0
    guard let type = AVAudioSession.InterruptionType(rawValue: rawType) else { return }
    switch type {
    case .began:
      guard state == .recording else { return }
      interrupted = true
      recoveryStartedUptime = ProcessInfo.processInfo.systemUptime
      stopTimers()
      closeActiveChunk(reason: "system-interruption", preserve: true)
      state = .paused
      appendJournal("interruption-began", fields: [:])
    case .ended:
      let optionsValue = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
      let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)
      guard interrupted else { return }
      interrupted = false
      guard !deliberatelyPaused, options.contains(.shouldResume) else {
        appendJournal("interruption-ended", fields: ["resumed": false])
        return
      }
      do {
        try configureAudioSession()
        chunkIndex += 1
        try openAndStartChunk(reason: "interruption-recovery")
        state = .recording
        routeRestartCount += 1
        let gap = max(0, (ProcessInfo.processInfo.systemUptime - (recoveryStartedUptime ?? ProcessInfo.processInfo.systemUptime)) * 1_000)
        captureGapMs += gap
        startTimers()
        appendJournal("interruption-ended", fields: ["resumed": true, "gapMs": gap])
      } catch {
        fail("Microphone could not resume after a system interruption", error: error)
      }
    @unknown default:
      break
    }
  }

  private func tearDownSession() {
    stopTimers()
    do { try audioSession.setActive(false, options: .notifyOthersOnDeactivation) } catch { /* best effort */ }
  }

  private func resetIdle() {
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
