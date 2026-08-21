package com.divay.maina.recorder

import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
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
import kotlin.math.max

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
        val lastError: String?,
    ) {
        fun asMap(): Map<String, Any?> = mapOf(
            "state" to state,
            "meetingId" to meetingId,
            "sourceMode" to sourceMode,
            "resolvedAudioSource" to resolvedAudioSource,
            "chunkIndex" to chunkIndex,
            "bytesWritten" to bytesWritten,
            "startedElapsedMs" to startedElapsedMs,
            "lastError" to lastError,
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
    private val lock = Any()
    private val journalLock = Any()
    @Volatile private var recorder: AudioRecord? = null
    @Volatile private var worker: Thread? = null
    @Volatile private var currentOptions: Options? = null
    @Volatile private var currentSource: Int? = null
    @Volatile private var currentChunkIndex = 0
    @Volatile private var currentBytesWritten = 0L
    @Volatile private var startedElapsedMs: Long? = null
    @Volatile private var lastError: String? = null

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
        lastError = lastError,
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
        currentSource = resolveAudioSource(options.sourceMode)

        val minBuffer = AudioRecord.getMinBufferSize(SAMPLE_RATE_HZ, CHANNEL_CONFIG, AUDIO_FORMAT)
        check(minBuffer > 0) { "AudioRecord does not support Maina's PCM format" }
        val bufferBytes = max(minBuffer * 4, SAMPLE_RATE_HZ / 2 * BYTES_PER_FRAME)
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
        recorder = created
        running.set(true)
        paused.set(false)
        created.startRecording()
        appendJournal(directory, "started", mapOf(
            "meetingId" to options.meetingId,
            "sourceMode" to options.sourceMode,
            "resolvedAudioSource" to currentSource,
            "chunkDurationMs" to options.chunkDurationMs,
        ))
        onEvent("info", "native-capture-started", snapshot().asMap())
        worker = thread(name = "MainaNativeCapture", isDaemon = true) { recordLoop(directory, bufferBytes) }
        snapshot()
    }

    fun pause(): Snapshot {
        if (!running.get()) return snapshot()
        paused.set(true)
        runCatching { recorder?.stop() }
        currentOptions?.let { appendJournal(directoryFrom(it.directory), "paused", emptyMap()) }
        onEvent("info", "native-capture-paused", snapshot().asMap())
        return snapshot()
    }

    fun resume(): Snapshot {
        if (!running.get() || !paused.get()) return snapshot()
        runCatching { recorder?.startRecording() }.onFailure { fail("resume-failed", it) }
        paused.set(false)
        currentOptions?.let { appendJournal(directoryFrom(it.directory), "resumed", emptyMap()) }
        onEvent("info", "native-capture-resumed", snapshot().asMap())
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
        runCatching { recorder?.release() }
        recorder = null
        currentOptions?.let { appendJournal(directoryFrom(it.directory), "stopped", snapshot().asMap()) }
        onEvent("info", "native-capture-stopped", snapshot().asMap())
        snapshot()
    }

    private fun recordLoop(directory: File, bufferBytes: Int) {
        val buffer = ByteArray(bufferBytes)
        var activeChunk: ActiveChunk? = null
        try {
            while (running.get()) {
                if (paused.get()) {
                    closeChunk(activeChunk, directory, "pause")
                    activeChunk = null
                    Thread.sleep(50)
                    continue
                }
                if (activeChunk == null) activeChunk = openChunk(directory)
                val read = recorder?.read(buffer, 0, buffer.size, AudioRecord.READ_BLOCKING) ?: AudioRecord.ERROR_INVALID_OPERATION
                when {
                    read > 0 -> {
                        activeChunk.output.write(buffer, 0, read)
                        activeChunk.bytes += read
                        currentBytesWritten = activeChunk.bytes
                        val now = SystemClock.elapsedRealtime()
                        if (now - activeChunk.lastSyncElapsedMs >= SYNC_INTERVAL_MS) {
                            activeChunk.output.fd.sync()
                            activeChunk.lastSyncElapsedMs = now
                        }
                        if (activeChunk.bytes >= activeChunk.maxBytes) {
                            closeChunk(activeChunk, directory, "rotation")
                            activeChunk = null
                            currentChunkIndex += 1
                            currentBytesWritten = 0L
                        }
                    }
                    read == 0 -> Unit
                    read < 0 && (!running.get() || paused.get()) -> Unit
                    else -> throw IllegalStateException("AudioRecord read failed: $read")
                }
            }
        } catch (cause: Throwable) {
            fail("capture-loop-failed", cause)
        } finally {
            closeChunk(activeChunk, directory, "stop")
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
