import AVFAudio
import CryptoKit
import Foundation
import SherpaOnnxC
import UIKit

/**
 * Small iOS-only adapter around sherpa-onnx's official Qwen3-ASR C API.
 * The recorder and ASR never share microphone ownership: this class reads only
 * finalized, immutable 16 kHz mono PCM WAV windows after capture.
 */
final class MainaQwenAsr {
  static let shared = MainaQwenAsr()

  struct ModelIdentity {
    let modelId: String
    let modelVersion: String
    let runtimeVersion: String
  }

  private let inferenceQueue = DispatchQueue(label: "com.divay.maina.ios.qwen", qos: .utility)
  private let modelPacks = MainaModelPackLifecycle.shared
  private var recognizer: OpaquePointer?
  private var activePack: MainaModelPackLifecycle.ReadyHandle?
  private var activeRoot: URL?
  private var memoryWarningObserver: NSObjectProtocol?
  private var thermalObserver: NSObjectProtocol?

  private let requiredFiles: [String: UInt64] = [
    "conv_frontend.onnx": 44_148_281,
    "encoder.int8.onnx": 182_491_662,
    "decoder.int8.onnx": 755_914_231,
    "tokenizer/vocab.json": 2_776_833,
    "tokenizer/merges.txt": 1_671_853,
    "tokenizer/tokenizer_config.json": 12_487,
  ]

  private init() {
    memoryWarningObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.didReceiveMemoryWarningNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      self?.inferenceQueue.async { self?.releaseNow() }
    }
    thermalObserver = NotificationCenter.default.addObserver(
      forName: ProcessInfo.thermalStateDidChangeNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      guard Self.mustDeferForThermalState else { return }
      self?.inferenceQueue.async { self?.releaseNow() }
    }
  }

  func status() -> [String: Any] {
    if let lifecycleStatus = try? modelPacks.status(), lifecycleStatus.state != "unavailable" {
      guard lifecycleStatus.state == "ready", let handle = try? modelPacks.acquireReady() else {
        return ["ready": false, "root": NSNull(), "reason": lifecycleStatus.reasonCode]
      }
      defer { try? handle.release() }
      if let reason = invalidModelFile(handle.root) {
        return ["ready": false, "root": handle.root.path, "reason": reason]
      }
      return ["ready": true, "root": handle.root.path, "reason": NSNull()]
    }
    let root = legacyModelRoot()
    if let reason = invalidModelFile(root) {
      return ["ready": false, "root": root.path, "reason": reason]
    }
    return ["ready": true, "root": root.path, "reason": NSNull()]
  }

  private func invalidModelFile(_ root: URL) -> String? {
    for (relative, expectedBytes) in requiredFiles.sorted(by: { $0.key < $1.key }) {
      let file = root.appendingPathComponent(relative)
      guard FileManager.default.fileExists(atPath: file.path) else {
        return "Missing model file: \(relative)"
      }
      guard let values = try? file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey]),
        values.isRegularFile == true, values.isSymbolicLink != true,
        file.resolvingSymlinksInPath() == file.standardizedFileURL,
        let rawSize = values.fileSize, rawSize >= 0
      else { return "Invalid model file: \(relative)" }
      let actual = UInt64(rawSize)
      if actual != expectedBytes {
        return "Invalid model file size: \(relative) (\(actual) != \(expectedBytes))"
      }
    }
    return nil
  }

  func transcribe(
    uri: String,
    startMs: Double,
    endMs: Double,
    completion: @escaping (Result<[String: Any], Error>) -> Void
  ) {
    inferenceQueue.async {
      do {
        completion(.success(try self.transcribeNow(uri: uri, startMs: startMs, endMs: endMs)))
      } catch {
        self.releaseNow()
        completion(.failure(error))
      }
    }
  }

  func release() {
    inferenceQueue.sync { releaseNow() }
  }

  func modelIdentity() throws -> ModelIdentity {
    try inferenceQueue.sync {
      _ = try resolveModelRoot()
      return ModelIdentity(
        modelId: "qwen3-0.6b-int8",
        modelVersion: activePack?.packVersion ?? "1",
        runtimeVersion: activePack?.runtimeVersion ?? "sherpa-onnx-1.13.4-ios-no-tts"
      )
    }
  }

  func bindExactResult(
    modelVersion: String,
    runtimeVersion: String,
    resultId: String,
    resultPayloadSha256: String
  ) throws -> Bool {
    try inferenceQueue.sync {
      if let activePack {
        return try modelPacks.noteExactResult(
          handle: activePack,
          modelVersion: modelVersion,
          runtimeVersion: runtimeVersion,
          resultId: resultId,
          resultPayloadSha256: resultPayloadSha256
        )
      }
      let lifecycleStatus = try modelPacks.status()
      if lifecycleStatus.state == "unavailable" { return modelVersion == "1" && runtimeVersion == "sherpa-onnx-1.13.4-ios-no-tts" }
      return try modelPacks.noteExactResult(
        handle: activePack,
        modelVersion: modelVersion,
        runtimeVersion: runtimeVersion,
        resultId: resultId,
        resultPayloadSha256: resultPayloadSha256
      )
    }
  }

  private func transcribeNow(uri: String, startMs: Double, endMs: Double) throws -> [String: Any] {
    guard !Self.mustDeferForThermalState else {
      releaseNow()
      throw failure(1109, "iPhone is too warm for reliable local transcription. Maina will continue automatically after it cools.")
    }
    let modelRoot = try resolveModelRoot()

    let window = try readWindow(uri: uri, requestedStartMs: startMs, requestedEndMs: endMs)
    guard !window.samples.isEmpty else { throw failure(1102, "ASR window contains no PCM samples.") }
    let activeRecognizer: OpaquePointer
    if let recognizer {
      activeRecognizer = recognizer
    } else {
      do {
        activeRecognizer = try createRecognizer(root: modelRoot)
        activeRoot = modelRoot
      } catch {
        if let activePack { _ = try? modelPacks.rollbackAfterOpenFailure(activePack) }
        releaseNow()
        throw error
      }
      recognizer = activeRecognizer
    }

    guard let stream = SherpaOnnxCreateOfflineStream(activeRecognizer) else {
      throw failure(1103, "Sherpa could not create an offline ASR stream.")
    }
    defer { SherpaOnnxDestroyOfflineStream(stream) }

    window.samples.withUnsafeBufferPointer { samples in
      SherpaOnnxAcceptWaveformOffline(stream, 16_000, samples.baseAddress, Int32(samples.count))
    }
    "128".withCString { value in
      "max_new_tokens".withCString { key in
        SherpaOnnxOfflineStreamSetOption(stream, key, value)
      }
    }

    let started = Date()
    SherpaOnnxDecodeOfflineStream(activeRecognizer, stream)
    guard let rawResult = SherpaOnnxGetOfflineStreamResult(stream) else {
      throw failure(1104, "Sherpa returned no recognition result.")
    }
    defer { SherpaOnnxDestroyOfflineRecognizerResult(rawResult) }

    let result = rawResult.pointee
    let text = result.text.map { String(cString: $0).trimmingCharacters(in: .whitespacesAndNewlines) } ?? ""
    let language = result.lang.map { String(cString: $0) } ?? ""
    let tokenCount = Int(result.count)
    let levels = Self.levels(window.samples)
    return [
      "outcome": text.isEmpty ? "empty" : "success",
      "text": text,
      "language": language,
      "processingMs": Int(Date().timeIntervalSince(started) * 1_000),
      "durationMs": window.endMs - window.startMs,
      "windowStartMs": window.startMs,
      "windowEndMs": window.endMs,
      "rmsDbfs": levels.rms,
      "peakDbfs": levels.peak,
      "speechExpected": levels.rms >= -55,
      "truncationSuspected": tokenCount >= 128,
      "tokenCount": tokenCount,
      "maxNewTokens": 128,
      "engineId": "qwen3-0.6b-int8",
      "engineVersion": "sherpa-onnx-1.13.4-ios-no-tts",
    ]
  }

  private func createRecognizer(root: URL) throws -> OpaquePointer {
    let convFrontend = root.appendingPathComponent("conv_frontend.onnx").path
    let encoder = root.appendingPathComponent("encoder.int8.onnx").path
    let decoder = root.appendingPathComponent("decoder.int8.onnx").path
    let tokenizer = root.appendingPathComponent("tokenizer").path
    var created: OpaquePointer?

    convFrontend.withCString { convPtr in
      encoder.withCString { encoderPtr in
        decoder.withCString { decoderPtr in
          tokenizer.withCString { tokenizerPtr in
            "".withCString { emptyPtr in
              "cpu".withCString { providerPtr in
                "greedy_search".withCString { decodingPtr in
                  var config = SherpaOnnxOfflineRecognizerConfig()
                  config.feat_config.sample_rate = 16_000
                  // Qwen3-ASR's official frontend uses 128-dimensional fbank
                  // features. Using Whisper's common 80-bin default silently
                  // degrades or rejects model input.
                  config.feat_config.feature_dim = 128
                  config.model_config.qwen3_asr.conv_frontend = convPtr
                  config.model_config.qwen3_asr.encoder = encoderPtr
                  config.model_config.qwen3_asr.decoder = decoderPtr
                  config.model_config.qwen3_asr.tokenizer = tokenizerPtr
                  config.model_config.qwen3_asr.max_total_len = 512
                  config.model_config.qwen3_asr.max_new_tokens = 128
                  config.model_config.qwen3_asr.temperature = 1e-6
                  config.model_config.qwen3_asr.top_p = 0.8
                  config.model_config.qwen3_asr.seed = 42
                  config.model_config.qwen3_asr.hotwords = emptyPtr
                  config.model_config.tokens = emptyPtr
                  config.model_config.num_threads = 2
                  config.model_config.provider = providerPtr
                  config.decoding_method = decodingPtr
                  created = SherpaOnnxCreateOfflineRecognizer(&config)
                }
              }
            }
          }
        }
      }
    }
    guard let created else { throw failure(1105, "Sherpa could not load the verified Qwen model pack.") }
    return created
  }

  private func releaseNow() {
    if let recognizer { SherpaOnnxDestroyOfflineRecognizer(recognizer) }
    recognizer = nil
    try? activePack?.release()
    activePack = nil
    activeRoot = nil
  }

  private static var mustDeferForThermalState: Bool {
    switch ProcessInfo.processInfo.thermalState {
    case .serious, .critical: return true
    case .nominal, .fair: return false
    @unknown default: return true
    }
  }

  private func legacyModelRoot() -> URL {
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return support
      .appendingPathComponent("Maina", isDirectory: true)
      .appendingPathComponent("models", isDirectory: true)
      .appendingPathComponent("qwen3-asr-0.6b-int8", isDirectory: true)
  }

  private func resolveModelRoot() throws -> URL {
    if let activePack, let activeRoot {
      guard activePack.root == activeRoot else { throw failure(1101, "MODEL_PACK_STATE_INVALID") }
      return activeRoot
    }
    if recognizer != nil, let activeRoot { return activeRoot }
    let lifecycleStatus = try modelPacks.status()
    if lifecycleStatus.state == "ready", let handle = try modelPacks.acquireReady() {
      if invalidModelFile(handle.root) == nil {
        activePack = handle
        return handle.root
      }
      _ = try? modelPacks.rollbackAfterOpenFailure(handle)
      try? handle.release()
      throw failure(1101, "Verified Qwen model pack could not be opened.")
    }
    if lifecycleStatus.state != "unavailable" {
      throw failure(1101, lifecycleStatus.reasonCode)
    }
    let legacy = legacyModelRoot()
    if let reason = invalidModelFile(legacy) { throw failure(1101, reason) }
    return legacy
  }

  func smoke(root: URL, uri: String) throws -> MainaModelPackLifecycle.SmokeEvidence {
    let input = Self.fileURL(uri)
    let values = try input.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
    guard values.isRegularFile == true, values.isSymbolicLink != true,
      input.resolvingSymlinksInPath() == input.standardizedFileURL
    else { throw failure(1110, "MODEL_PACK_SMOKE_INPUT_INVALID") }
    let inputSha = try sha256(input)
    let window = try readWindow(uri: uri, requestedStartMs: 0, requestedEndMs: .greatestFiniteMagnitude)
    guard !window.samples.isEmpty else { throw failure(1110, "MODEL_PACK_SMOKE_INPUT_INVALID") }
    let startedAt = Int64(Date().timeIntervalSince1970 * 1_000)
    let smokeRecognizer = try createRecognizer(root: root)
    guard let stream = SherpaOnnxCreateOfflineStream(smokeRecognizer) else {
      SherpaOnnxDestroyOfflineRecognizer(smokeRecognizer)
      throw failure(1103, "Sherpa could not create an offline ASR stream.")
    }
    defer {
      SherpaOnnxDestroyOfflineStream(stream)
      SherpaOnnxDestroyOfflineRecognizer(smokeRecognizer)
    }
    window.samples.withUnsafeBufferPointer { samples in
      SherpaOnnxAcceptWaveformOffline(stream, 16_000, samples.baseAddress, Int32(samples.count))
    }
    "128".withCString { value in
      "max_new_tokens".withCString { key in SherpaOnnxOfflineStreamSetOption(stream, key, value) }
    }
    SherpaOnnxDecodeOfflineStream(smokeRecognizer, stream)
    guard let rawResult = SherpaOnnxGetOfflineStreamResult(stream) else {
      throw failure(1104, "Sherpa returned no recognition result.")
    }
    defer { SherpaOnnxDestroyOfflineRecognizerResult(rawResult) }
    let text = rawResult.pointee.text.map { String(cString: $0) } ?? ""
    let normalized = text.precomposedStringWithCanonicalMapping
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
      .lowercased(with: Locale(identifier: "en_US_POSIX"))
    return .init(
      inputSha256: inputSha,
      normalizedTextSha256: sha256(Data(normalized.utf8)),
      startedAt: startedAt,
      completedAt: Int64(Date().timeIntervalSince1970 * 1_000)
    )
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

  private func readWindow(uri: String, requestedStartMs: Double, requestedEndMs: Double) throws -> AudioWindow {
    let url = Self.fileURL(uri)
    let file = try AVAudioFile(forReading: url)
    let format = file.processingFormat
    guard abs(format.sampleRate - 16_000) < 1, format.channelCount == 1 else {
      throw failure(1106, "Qwen accepts Maina 16 kHz mono PCM WAV chunks only.")
    }
    let totalFrames = file.length
    let totalDurationMs = Double(totalFrames) * 1_000 / format.sampleRate
    let startMs = min(max(0, requestedStartMs), totalDurationMs)
    let safeRequestedEnd = requestedEndMs > startMs ? requestedEndMs : totalDurationMs
    let endMs = min(max(startMs, safeRequestedEnd), totalDurationMs)
    let startFrame = AVAudioFramePosition(startMs * format.sampleRate / 1_000)
    let endFrame = AVAudioFramePosition(endMs * format.sampleRate / 1_000)
    let frameCount = AVAudioFrameCount(max(0, endFrame - startFrame))
    guard frameCount > 0 else { throw failure(1102, "ASR window contains no PCM samples.") }
    file.framePosition = startFrame
    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else {
      throw failure(1107, "Maina could not allocate the ASR audio buffer.")
    }
    try file.read(into: buffer, frameCount: frameCount)
    guard let channel = buffer.floatChannelData?[0] else {
      throw failure(1108, "Maina could not decode the WAV samples.")
    }
    let samples = Array(UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength)))
    return AudioWindow(samples: samples, startMs: Int(startMs), endMs: Int(endMs))
  }

  private static func levels(_ samples: [Float]) -> (rms: Double, peak: Double) {
    guard !samples.isEmpty else { return (-180, -180) }
    var sumSquares = 0.0
    var peak = 0.0
    for sample in samples {
      let value = Double(sample)
      sumSquares += value * value
      peak = max(peak, abs(value))
    }
    let rms = sqrt(sumSquares / Double(samples.count))
    return (20 * log10(max(rms, 1e-9)), 20 * log10(max(peak, 1e-9)))
  }

  private static func fileURL(_ value: String) -> URL {
    if value.hasPrefix("file:"), let url = URL(string: value) { return url }
    return URL(fileURLWithPath: value)
  }

  private func failure(_ code: Int, _ message: String) -> NSError {
    NSError(domain: "MainaQwenAsr", code: code, userInfo: [NSLocalizedDescriptionKey: message])
  }

  private struct AudioWindow {
    let samples: [Float]
    let startMs: Int
    let endMs: Int
  }
}
