package com.divay.maina.recorder

import android.content.Context
import android.media.AudioFormat
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioRouting
import android.media.MediaRecorder
import android.os.Build
import android.os.SystemClock
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.net.URI
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.sqrt

/**
 * Service-owned, crash-safe PCM capture.
 *
 * This deliberately contains no ASR, VAD, JS callbacks required for progress,
 * or network work. Every finalized chunk is a valid WAV and has a durable
 * append-only journal record before the next chunk starts.
 */
internal class MainaNativeAudioCapture(
    private val context: Context,
    private val onEvent: (level: String, event: String, payload: Map<String, Any?>) -> Unit,
    private val onStatus: (payload: Map<String, Any?>) -> Unit = {},
) {
    data class Options(
        val meetingId: String,
        val directory: String,
        val sourceMode: String,
        val chunkDurationMs: Long,
    )

    data class Snapshot(
        val state: String,
        val meetingId: String?,
        val sourceMode: String?,
        val resolvedAudioSource: Int?,
        val chunkIndex: Int,
        val bytesWritten: Long,
        val startedElapsedMs: Long?,
        val lastProgressAtMs: Long?,
        val lastError: String?,
        val routeRestartCount: Int,
        val routeRecoveryActive: Boolean,
        val routedDeviceId: Int?,
        val routedDeviceType: Int?,
        val routedDeviceName: String?,
        val lastRouteChangeElapsedMs: Long?,
        val captureGapMs: Long,
        val rmsDbfs: Double,
        val peakDbfs: Double,
    ) {
        fun asMap(): Map<String, Any?> = mapOf(
            "state" to state,
            "meetingId" to meetingId,
            "sourceMode" to sourceMode,
            "resolvedAudioSource" to resolvedAudioSource,
            "chunkIndex" to chunkIndex,
            "bytesWritten" to bytesWritten,
            "startedElapsedMs" to startedElapsedMs,
            "lastProgressAtMs" to lastProgressAtMs,
            "lastError" to lastError,
            "routeRestartCount" to routeRestartCount,
            "routeRecoveryActive" to routeRecoveryActive,
            "routedDeviceId" to routedDeviceId,
            "routedDeviceType" to routedDeviceType,
            "routedDeviceName" to routedDeviceName,
            "lastRouteChangeElapsedMs" to lastRouteChangeElapsedMs,
            "captureGapMs" to captureGapMs,
            "rmsDbfs" to rmsDbfs,
            "peakDbfs" to peakDbfs,
        )
    }

    data class DirectoryInspection(
        val finalizedUris: List<String>,
        val partialUris: List<String>,
        val recoveredCount: Int,
        val invalidPartialCount: Int,
        val journalUri: String?,
    ) {
        fun asMap(): Map<String, Any?> = mapOf(
            "finalizedUris" to finalizedUris,
            "partialUris" to partialUris,
            "recoveredCount" to recoveredCount,
            "invalidPartialCount" to invalidPartialCount,
            "journalUri" to journalUri,
        )
    }

    private val running = AtomicBoolean(false)
    private val paused = AtomicBoolean(false)
    private val routeRefreshRequested = AtomicBoolean(false)
    private val lock = Any()
    private val recorderLock = Any()
    private val journalLock = Any()
    private val audioManager = context.getSystemService(AudioManager::class.java)
    @Volatile private var recorder: AudioRecord? = null
    @Volatile private var worker: Thread? = null
    @Volatile private var currentOptions: Options? = null
    @Volatile private var currentSource: Int? = null
    @Volatile private var currentChunkIndex = 0
    @Volatile private var currentBytesWritten = 0L
    @Volatile private var startedElapsedMs: Long? = null
    @Volatile private var lastProgressAtMs: Long? = null
    @Volatile private var lastError: String? = null
    @Volatile private var bufferBytes = 0
    @Volatile private var routeRefreshReason = "initial"
    @Volatile private var routeRestartCount = 0
    @Volatile private var routeRecoveryActive = false
    @Volatile private var routedDeviceId: Int? = null
    @Volatile private var routedDeviceType: Int? = null
    @Volatile private var routedDeviceName: String? = null
    @Volatile private var lastRouteChangeElapsedMs: Long? = null
    @Volatile private var captureGapMs = 0L
    @Volatile private var rmsDbfs = -90.0
    @Volatile private var peakDbfs = -90.0
    @Volatile private var lastStatusPublishElapsedMs = 0L

    private val routingListener = AudioRouting.OnRoutingChangedListener { routing ->
        val activeRecorder = routing as? AudioRecord ?: return@OnRoutingChangedListener
        updateRoutedDevice(activeRecorder)
    }

    fun snapshot(): Snapshot = Snapshot(
        state = when {
            running.get() && paused.get() -> "paused"
            running.get() -> "recording"
            else -> "idle"
        },
        meetingId = currentOptions?.meetingId,
        sourceMode = currentOptions?.sourceMode,
        resolvedAudioSource = currentSource,
        chunkIndex = currentChunkIndex,
        bytesWritten = currentBytesWritten,
        startedElapsedMs = startedElapsedMs,
        lastProgressAtMs = lastProgressAtMs,
        lastError = lastError,
        routeRestartCount = routeRestartCount,
        routeRecoveryActive = routeRecoveryActive,
        routedDeviceId = routedDeviceId,
        routedDeviceType = routedDeviceType,
        routedDeviceName = routedDeviceName,
        lastRouteChangeElapsedMs = lastRouteChangeElapsedMs,
        captureGapMs = captureGapMs,
        rmsDbfs = rmsDbfs,
        peakDbfs = peakDbfs,
    )

    fun start(options: Options): Snapshot = synchronized(lock) {
        check(!running.get()) { "Native capture is already active" }
        require(options.meetingId.isNotBlank()) { "meetingId is required" }
        require(options.chunkDurationMs in 30_000L..10 * 60_000L) { "chunkDurationMs must be 30 seconds to 10 minutes" }
        val directory = directoryFrom(options.directory)
        check(directory.exists() || directory.mkdirs()) { "Could not create capture directory" }

        lastError = null
        currentOptions = options
        currentChunkIndex = nextChunkIndex(directory)
        currentBytesWritten = 0L
        startedElapsedMs = SystemClock.elapsedRealtime()
        lastProgressAtMs = System.currentTimeMillis()
        currentSource = resolveAudioSource(options.sourceMode)
        routeRestartCount = 0
        routeRecoveryActive = false
        routedDeviceId = null
        routedDeviceType = null
        routedDeviceName = null
        lastRouteChangeElapsedMs = null
        captureGapMs = 0L
        rmsDbfs = -90.0
        peakDbfs = -90.0
        routeRefreshRequested.set(false)
        routeRefreshReason = "initial"

        val minBuffer = AudioRecord.getMinBufferSize(SAMPLE_RATE_HZ, CHANNEL_CONFIG, AUDIO_FORMAT)
        check(minBuffer > 0) { "AudioRecord does not support Maina's PCM format" }
        bufferBytes = max(minBuffer * 4, SAMPLE_RATE_HZ / 2 * BYTES_PER_FRAME)
        val created = createAndStartRecorder()
        running.set(true)
        paused.set(false)
        updateRoutedDevice(created)
        appendJournal(directory, "started", mapOf(
            "meetingId" to options.meetingId,
            "sourceMode" to options.sourceMode,
            "resolvedAudioSource" to currentSource,
            "chunkDurationMs" to options.chunkDurationMs,
        ))
        onEvent("info", "native-capture-started", snapshot().asMap())
        publishStatus()
        worker = thread(name = "MainaNativeCapture", isDaemon = true) { recordLoop(directory, bufferBytes) }
        snapshot()
    }

    fun requestRouteRefresh(change: String, device: AudioDeviceInfo) {
        if (!running.get()) return
        routeRefreshReason = "$change:${device.type}:${device.id}"
        lastRouteChangeElapsedMs = SystemClock.elapsedRealtime()
        routeRefreshRequested.set(true)
        onEvent("info", "native-capture-route-refresh-requested", snapshot().asMap() + mapOf(
            "change" to change,
            "deviceId" to device.id,
            "deviceType" to device.type,
            "deviceName" to device.productName.toString(),
        ))
        // A blocking read must be released before the worker can recreate the
        // recorder against Android's newly selected input route.
        synchronized(recorderLock) { runCatching { recorder?.stop() } }
    }

    fun pause(): Snapshot {
        if (!running.get()) return snapshot()
        paused.set(true)
        runCatching { recorder?.stop() }
        currentOptions?.let { appendJournal(directoryFrom(it.directory), "paused", emptyMap()) }
        onEvent("info", "native-capture-paused", snapshot().asMap())
        publishStatus()
        return snapshot()
    }

    fun resume(): Snapshot {
        if (!running.get() || !paused.get()) return snapshot()
        paused.set(false)
        routeRefreshReason = "resume"
        routeRefreshRequested.set(true)
        currentOptions?.let { appendJournal(directoryFrom(it.directory), "resumed", emptyMap()) }
        onEvent("info", "native-capture-resumed", snapshot().asMap())
        publishStatus()
        return snapshot()
    }

    fun stop(): Snapshot = synchronized(lock) {
        val wasRunning = running.getAndSet(false)
        if (!wasRunning && worker == null) return snapshot()
        paused.set(false)
        runCatching { recorder?.stop() }
        val activeWorker = worker
        activeWorker?.join(STOP_JOIN_TIMEOUT_MS)
        check(activeWorker?.isAlive != true) {
            "Native capture did not finalize within ${STOP_JOIN_TIMEOUT_MS}ms"
        }
        worker = null
        releaseRecorder()
        currentOptions?.let { appendJournal(directoryFrom(it.directory), "stopped", snapshot().asMap()) }
        onEvent("info", "native-capture-stopped", snapshot().asMap())
        publishStatus()
        snapshot()
    }

    private fun recordLoop(directory: File, bufferBytes: Int) {
        val buffer = ByteArray(bufferBytes)
        var activeChunk: ActiveChunk? = null
        try {
            while (running.get()) {
                if (paused.get()) {
                    currentChunkIndex = MainaChunkBoundaryPolicy.nextChunkIndex(
                        currentChunkIndex,
                        hadActiveChunk = activeChunk != null,
                        reason = MainaChunkBoundaryPolicy.BoundaryReason.PAUSE,
                    )
                    closeChunk(activeChunk, directory, "pause")
                    activeChunk = null
                    currentBytesWritten = 0L
                    Thread.sleep(50)
                    continue
                }
                if (routeRefreshRequested.getAndSet(false)) {
                    val hadActiveChunk = activeChunk != null
                    closeChunk(activeChunk, directory, "route-change")
                    activeChunk = null
                    currentChunkIndex = MainaChunkBoundaryPolicy.nextChunkIndex(
                        currentChunkIndex,
                        hadActiveChunk,
                        MainaChunkBoundaryPolicy.BoundaryReason.ROUTE_CHANGE,
                    )
                    currentBytesWritten = 0L
                    recoverRecorder(directory, routeRefreshReason)
                    continue
                }
                if (activeChunk == null) activeChunk = openChunk(directory)
                val read = recorder?.read(buffer, 0, buffer.size, AudioRecord.READ_BLOCKING) ?: AudioRecord.ERROR_INVALID_OPERATION
                when {
                    read > 0 -> {
                        activeChunk.output.write(buffer, 0, read)
                        activeChunk.bytes += read
                        currentBytesWritten = activeChunk.bytes
                        updateLevels(buffer, read)
                        lastProgressAtMs = System.currentTimeMillis()
                        val now = SystemClock.elapsedRealtime()
                        publishStatusIfDue(now)
                        if (now - activeChunk.lastSyncElapsedMs >= SYNC_INTERVAL_MS) {
                            activeChunk.output.fd.sync()
                            activeChunk.lastSyncElapsedMs = now
                        }
                        if (activeChunk.bytes >= activeChunk.maxBytes) {
                            closeChunk(activeChunk, directory, "rotation")
                            activeChunk = null
                            currentChunkIndex = MainaChunkBoundaryPolicy.nextChunkIndex(
                                currentChunkIndex,
                                hadActiveChunk = true,
                                reason = MainaChunkBoundaryPolicy.BoundaryReason.ROTATION,
                            )
                            currentBytesWritten = 0L
                        }
                    }
                    read == 0 -> Unit
                    read < 0 && (!running.get() || paused.get()) -> Unit
                    read < 0 && MainaAudioCaptureRecoveryPolicy.shouldRecover(read, routeRefreshRequested.get()) -> {
                        closeChunk(activeChunk, directory, "read-recovery")
                        activeChunk = null
                        currentChunkIndex = MainaChunkBoundaryPolicy.nextChunkIndex(
                            currentChunkIndex,
                            hadActiveChunk = true,
                            reason = MainaChunkBoundaryPolicy.BoundaryReason.READ_RECOVERY,
                        )
                        currentBytesWritten = 0L
                        routeRefreshRequested.set(false)
                        recoverRecorder(directory, "read-error:$read")
                    }
                    else -> throw IllegalStateException("AudioRecord read failed: $read")
                }
            }
        } catch (cause: Throwable) {
            fail("capture-loop-failed", cause)
        } finally {
            closeChunk(activeChunk, directory, "stop")
        }
    }

    private fun updateLevels(buffer: ByteArray, length: Int) {
        var sumSquares = 0.0
        var peak = 0.0
        var samples = 0
        var offset = 0
        while (offset + 1 < length) {
            val low = buffer[offset].toInt() and 0xff
            val high = buffer[offset + 1].toInt()
            val value = ((high shl 8) or low).toShort().toDouble() / 32768.0
            sumSquares += value * value
            peak = max(peak, abs(value))
            samples += 1
            offset += BYTES_PER_FRAME * 4
        }
        if (samples == 0) return
        val rms = sqrt(sumSquares / samples)
        rmsDbfs = 20.0 * log10(rms.coerceAtLeast(1e-9))
        peakDbfs = 20.0 * log10(peak.coerceAtLeast(1e-9))
    }

    private fun recoverRecorder(directory: File, reason: String) {
        val recoveryStarted = SystemClock.elapsedRealtime()
        routeRecoveryActive = true
        releaseRecorder()
        appendJournal(directory, "route-recovery-started", mapOf("reason" to reason))
        onEvent("warn", "native-capture-route-recovery-started", snapshot().asMap() + mapOf("reason" to reason))
        var attempt = 0
        while (running.get() && !paused.get()) {
            val elapsed = SystemClock.elapsedRealtime() - recoveryStarted
            if (!MainaAudioCaptureRecoveryPolicy.isWithinRecoveryBudget(elapsed)) break
            if (attempt > 0) Thread.sleep(MainaAudioCaptureRecoveryPolicy.delayMs(attempt - 1))
            val recovered = runCatching {
                createAndStartRecorder(
                    preferExternalInput = MainaAudioCaptureRecoveryPolicy.shouldPreferExternalInput(attempt),
                )
            }
            if (recovered.isSuccess) {
                routeRestartCount += 1
                routeRecoveryActive = false
                val gap = SystemClock.elapsedRealtime() - recoveryStarted
                captureGapMs += gap
                lastProgressAtMs = System.currentTimeMillis()
                lastError = null
                updateRoutedDevice(recovered.getOrThrow())
                appendJournal(directory, "route-recovered", mapOf(
                    "reason" to reason,
                    "attempts" to (attempt + 1),
                    "gapMs" to gap,
                    "routeRestartCount" to routeRestartCount,
                    "routedDeviceId" to routedDeviceId,
                    "routedDeviceType" to routedDeviceType,
                    "routedDeviceName" to routedDeviceName,
                ))
                onEvent("info", "native-capture-route-recovered", snapshot().asMap() + mapOf(
                    "reason" to reason,
                    "attempts" to (attempt + 1),
                    "gapMs" to gap,
                ))
                publishStatus()
                return
            }
            val cause = recovered.exceptionOrNull()
            lastError = cause?.message ?: cause?.javaClass?.simpleName ?: "Audio route recovery failed"
            attempt += 1
            if (attempt == 1 || attempt % 5 == 0) {
                onEvent("warn", "native-capture-route-recovery-retrying", snapshot().asMap() + mapOf(
                    "reason" to reason,
                    "attempt" to attempt,
                    "error" to lastError,
                ))
            }
        }
        routeRecoveryActive = false
        if (running.get() && !paused.get()) {
            val message = "Audio input could not recover within ${MainaAudioCaptureRecoveryPolicy.MAX_ROUTE_RECOVERY_MS}ms"
            lastError = message
            appendJournal(directory, "route-recovery-exhausted", mapOf(
                "reason" to reason,
                "attempts" to attempt,
                "captureGapMs" to (SystemClock.elapsedRealtime() - recoveryStarted),
                "error" to message,
            ))
            onEvent("error", "native-capture-route-recovery-exhausted", snapshot().asMap() + mapOf(
                "reason" to reason,
                "attempts" to attempt,
                "error" to message,
            ))
            // Do not let a meeting look live while no PCM is being written. The
            // active WAV chunks are already durable and app recovery can route
            // them into post-processing on the next foreground reconciliation.
            running.set(false)
            publishStatus()
        }
    }

    private fun publishStatusIfDue(now: Long) {
        if (now - lastStatusPublishElapsedMs < STATUS_PUBLISH_INTERVAL_MS) return
        lastStatusPublishElapsedMs = now
        onStatus(snapshot().asMap())
    }

    private fun publishStatus() {
        lastStatusPublishElapsedMs = SystemClock.elapsedRealtime()
        onStatus(snapshot().asMap())
    }

    private fun createAndStartRecorder(preferExternalInput: Boolean = true): AudioRecord {
        val created = AudioRecord.Builder()
            .setAudioSource(currentSource ?: MediaRecorder.AudioSource.VOICE_RECOGNITION)
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AUDIO_FORMAT)
                    .setSampleRate(SAMPLE_RATE_HZ)
                    .setChannelMask(CHANNEL_CONFIG)
                    .build(),
            )
            .setBufferSizeInBytes(bufferBytes)
            .build()
        check(created.state == AudioRecord.STATE_INITIALIZED) { "Native AudioRecord could not initialize" }
        created.addOnRoutingChangedListener(routingListener, null)
        preferredExternalInput()?.takeIf { preferExternalInput }?.let { preferred ->
            if (!created.setPreferredDevice(preferred)) {
                onEvent("warn", "native-capture-preferred-route-rejected", mapOf(
                    "deviceId" to preferred.id,
                    "deviceType" to preferred.type,
                    "deviceName" to preferred.productName.toString(),
                ))
            }
        }
        synchronized(recorderLock) { recorder = created }
        try {
            created.startRecording()
            check(created.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
                "Native AudioRecord did not enter recording state"
            }
            return created
        } catch (cause: Throwable) {
            runCatching { created.removeOnRoutingChangedListener(routingListener) }
            runCatching { created.release() }
            synchronized(recorderLock) {
                if (recorder === created) recorder = null
            }
            throw cause
        }
    }

    private fun releaseRecorder() {
        val active = synchronized(recorderLock) {
            recorder.also { recorder = null }
        } ?: return
        runCatching { active.removeOnRoutingChangedListener(routingListener) }
        runCatching { active.stop() }
        runCatching { active.release() }
    }

    private fun preferredExternalInput(): AudioDeviceInfo? = audioManager
        .getDevices(AudioManager.GET_DEVICES_INPUTS)
        .filter { MainaAudioRouteBridge.isExternalMicrophone(it) }
        .maxByOrNull { device -> MainaAudioCaptureRecoveryPolicy.externalInputPriority(device.type) }

    private fun updateRoutedDevice(activeRecorder: AudioRecord) {
        val device = runCatching { activeRecorder.routedDevice }.getOrNull() ?: return
        val changed = routedDeviceId != device.id || routedDeviceType != device.type
        routedDeviceId = device.id
        routedDeviceType = device.type
        routedDeviceName = device.productName.toString()
        if (changed) {
            lastRouteChangeElapsedMs = SystemClock.elapsedRealtime()
            onEvent("info", "native-capture-active-route", snapshot().asMap())
        }
    }

    private fun openChunk(directory: File): ActiveChunk {
        val index = currentChunkIndex
        val partial = File(directory, "capture-${index.toString().padStart(5, '0')}.wav.partial")
        val output = FileOutputStream(partial, false)
        output.write(ByteArray(WAV_HEADER_BYTES))
        output.fd.sync()
        val chunk = ActiveChunk(
            index = index,
            partial = partial,
            output = output,
            startedElapsedMs = SystemClock.elapsedRealtime(),
            lastSyncElapsedMs = SystemClock.elapsedRealtime(),
            maxBytes = currentOptions!!.chunkDurationMs * SAMPLE_RATE_HZ * BYTES_PER_FRAME / 1000,
        )
        appendJournal(directory, "chunk-opened", mapOf("index" to index, "partial" to partial.name))
        return chunk
    }

    private fun closeChunk(chunk: ActiveChunk?, directory: File, reason: String) {
        if (chunk == null) return
        runCatching {
            chunk.output.flush()
            chunk.output.fd.sync()
            chunk.output.close()
            if (chunk.bytes <= 0L) {
                appendJournal(directory, "chunk-empty", mapOf("index" to chunk.index, "reason" to reason))
                chunk.partial.delete()
                return@runCatching
            }
            writeWavHeaderFor(chunk.partial, chunk.bytes)
            val finalFile = File(directory, "capture-${chunk.index.toString().padStart(5, '0')}.wav")
            atomicMoveFile(chunk.partial, finalFile)
            val durationMs = chunk.bytes * 1000L / (SAMPLE_RATE_HZ * BYTES_PER_FRAME)
            appendJournal(directory, "chunk-finalized", mapOf(
                "index" to chunk.index,
                "file" to finalFile.name,
                "bytes" to chunk.bytes,
                "durationMs" to durationMs,
                "reason" to reason,
            ))
            onEvent("info", "native-capture-chunk-finalized", mapOf(
                "index" to chunk.index,
                "uri" to finalFile.toURI().toString(),
                "bytes" to chunk.bytes,
                "durationMs" to durationMs,
                "reason" to reason,
            ))
        }.onFailure { fail("chunk-finalization-failed", it) }
    }

    private fun fail(event: String, cause: Throwable) {
        lastError = cause.message ?: cause.javaClass.simpleName
        onEvent("error", event, snapshot().asMap() + mapOf("error" to lastError))
        currentOptions?.let { appendJournal(directoryFrom(it.directory), event, mapOf("error" to lastError)) }
    }

    private fun resolveAudioSource(mode: String): Int = when (mode.lowercase()) {
        "unprocessed" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N &&
            context.packageManager.hasSystemFeature(android.content.pm.PackageManager.FEATURE_AUDIO_PRO)) {
            MediaRecorder.AudioSource.UNPROCESSED
        } else MediaRecorder.AudioSource.VOICE_RECOGNITION
        "camcorder" -> MediaRecorder.AudioSource.CAMCORDER
        "mic" -> MediaRecorder.AudioSource.MIC
        else -> MediaRecorder.AudioSource.VOICE_RECOGNITION
    }

    private fun nextChunkIndex(directory: File): Int = directory.listFiles()
        ?.mapNotNull { file -> Regex("capture-(\\d+)\\.wav(?:\\.partial)?").matchEntire(file.name)?.groupValues?.get(1)?.toIntOrNull() }
        ?.maxOrNull()
        ?.plus(1)
        ?: 0

    private fun appendJournal(directory: File, event: String, fields: Map<String, Any?>) {
        val line = JSONObject().apply {
            put("id", UUID.randomUUID().toString())
            put("event", event)
            put("wallTimeMs", System.currentTimeMillis())
            put("elapsedMs", SystemClock.elapsedRealtime())
            fields.forEach { (key, value) -> put(key, value) }
        }.toString() + "\n"
        synchronized(journalLock) {
            FileOutputStream(File(directory, JOURNAL_NAME), true).use { output ->
                output.write(line.toByteArray(Charsets.UTF_8))
                output.fd.sync()
            }
        }
    }

    private data class ActiveChunk(
        val index: Int,
        val partial: File,
        val output: FileOutputStream,
        val startedElapsedMs: Long,
        var lastSyncElapsedMs: Long,
        val maxBytes: Long,
        var bytes: Long = 0L,
    )

    companion object {
        const val SAMPLE_RATE_HZ = 16_000
        const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
        const val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT
        const val BYTES_PER_FRAME = 2
        const val WAV_HEADER_BYTES = 44
        const val SYNC_INTERVAL_MS = 2_000L
        const val STATUS_PUBLISH_INTERVAL_MS = 250L
        const val STOP_JOIN_TIMEOUT_MS = 15_000L
        const val JOURNAL_NAME = "capture-journal.jsonl"

        fun inspectDirectory(uriOrPath: String, recoverPartials: Boolean): DirectoryInspection {
            val directory = directoryFrom(uriOrPath)
            if (!directory.isDirectory) {
                return DirectoryInspection(emptyList(), emptyList(), 0, 0, null)
            }

            var recoveredCount = 0
            var invalidPartialCount = 0
            if (recoverPartials) {
                directory.listFiles()
                    .orEmpty()
                    .filter { it.name.matches(Regex("capture-\\d+\\.wav\\.partial")) }
                    .sortedBy { it.name }
                    .forEach { partial ->
                        val finalFile = File(directory, partial.name.removeSuffix(".partial"))
                        when {
                            finalFile.exists() -> invalidPartialCount += 1
                            partial.length() <= WAV_HEADER_BYTES -> invalidPartialCount += 1
                            else -> runCatching {
                                writeWavHeaderFor(partial, partial.length() - WAV_HEADER_BYTES)
                                atomicMoveFile(partial, finalFile)
                                recoveredCount += 1
                            }.onFailure { invalidPartialCount += 1 }
                        }
                    }
            }

            val files = directory.listFiles().orEmpty()
            return DirectoryInspection(
                finalizedUris = files
                    .filter { it.name.matches(Regex("capture-\\d+\\.wav")) && it.length() > WAV_HEADER_BYTES }
                    .sortedBy { it.name }
                    .map { it.toURI().toString() },
                partialUris = files
                    .filter { it.name.matches(Regex("capture-\\d+\\.wav\\.partial")) }
                    .sortedBy { it.name }
                    .map { it.toURI().toString() },
                recoveredCount = recoveredCount,
                invalidPartialCount = invalidPartialCount,
                journalUri = File(directory, JOURNAL_NAME).takeIf { it.isFile }?.toURI()?.toString(),
            )
        }

        /** Native app-storage deletion with a truthful result. Expo's file
         * facade cannot consistently remove directories created by this
         * service across Android storage implementations. */
        fun deleteCaptureDirectory(uriOrPath: String): Boolean {
            val directory = directoryFrom(uriOrPath)
            if (!directory.exists()) return true
            return directory.deleteRecursively() && !directory.exists()
        }

        private fun directoryFrom(uriOrPath: String): File =
            if (uriOrPath.startsWith("file:")) File(URI(uriOrPath)) else File(uriOrPath)

        private fun writeWavHeaderFor(file: File, pcmBytes: Long) {
            require(pcmBytes in 0..0xffffffffL - 36L) { "WAV file is too large" }
            RandomAccessFile(file, "rw").use { wav ->
                wav.seek(0)
                wav.write("RIFF".toByteArray(Charsets.US_ASCII))
                writeLeInt(wav, 36L + pcmBytes)
                wav.write("WAVEfmt ".toByteArray(Charsets.US_ASCII))
                writeLeInt(wav, 16L)
                writeLeShort(wav, 1)
                writeLeShort(wav, 1)
                writeLeInt(wav, SAMPLE_RATE_HZ.toLong())
                writeLeInt(wav, (SAMPLE_RATE_HZ * BYTES_PER_FRAME).toLong())
                writeLeShort(wav, BYTES_PER_FRAME)
                writeLeShort(wav, 16)
                wav.write("data".toByteArray(Charsets.US_ASCII))
                writeLeInt(wav, pcmBytes)
                wav.fd.sync()
            }
        }

        private fun atomicMoveFile(source: File, target: File) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                try {
                    Files.move(source.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE)
                    return
                } catch (_: Throwable) {
                    // Same-directory rename remains atomic on Android's app filesystem.
                }
            }
            check(source.renameTo(target)) { "Could not finalize ${source.name}" }
        }

        private fun writeLeInt(file: RandomAccessFile, value: Long) =
            file.writeInt(Integer.reverseBytes(value.toInt()))

        private fun writeLeShort(file: RandomAccessFile, value: Int) =
            file.writeShort(java.lang.Short.reverseBytes(value.toShort()).toInt())
    }
}
