package com.divay.maina.recorder

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.Build
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.security.MessageDigest

internal data class PreparedArtifact(
    val path: String,
    val contentType: String,
    val codec: String,
    val extension: String,
    val bytes: Long,
    val sha256: String,
    val durationMs: Long,
)

internal object DiagnosticAudioTranscoder {
    private data class WavInfo(
        val sampleRate: Int,
        val channels: Int,
        val bitsPerSample: Int,
        val dataOffset: Long,
        val dataSize: Long,
    )

    fun prepare(artifact: ArtifactRecord, outputDir: File): PreparedArtifact {
        if (artifact.kind != "audio") {
            val file = File(artifact.preparedPath ?: artifact.sourcePath)
            require(file.isFile) { "Artifact source does not exist: ${file.absolutePath}" }
            return PreparedArtifact(
                path = file.absolutePath,
                contentType = artifact.contentType ?: "text/plain; charset=utf-8",
                codec = artifact.codec ?: "utf-8",
                extension = file.extension.ifBlank { "txt" },
                bytes = file.length(),
                sha256 = sha256(file),
                durationMs = artifact.durationMs,
            )
        }

        artifact.preparedPath?.let { existingPath ->
            val existing = File(existingPath)
            if (existing.isFile && existing.length() > 0L && artifact.contentType != null && artifact.codec != null) {
                return PreparedArtifact(
                    path = existing.absolutePath,
                    contentType = artifact.contentType,
                    codec = artifact.codec,
                    extension = existing.extension,
                    bytes = existing.length(),
                    sha256 = artifact.sha256 ?: sha256(existing),
                    durationMs = artifact.durationMs,
                )
            }
        }

        require(Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) { "Opus diagnostics require Android 10+" }
        val source = File(artifact.sourcePath)
        require(source.isFile && source.length() >= 44L) { "WAV source is missing or incomplete" }
        outputDir.mkdirs()
        val wav = readWavInfo(source)

        val opus = File(outputDir, "${artifact.artifactId}.ogg")
        val prepared = runCatching {
            encode(
                source = source,
                wav = wav,
                destination = opus,
                mime = MediaFormat.MIMETYPE_AUDIO_OPUS,
                muxerFormat = MediaMuxer.OutputFormat.MUXER_OUTPUT_OGG,
                bitRate = 32_000,
                codecName = "opus",
                contentType = "audio/ogg",
                extension = "ogg",
            )
        }.getOrElse { opus.delete(); null }
        if (prepared != null) return prepared

        // AAC-LC is the stability fallback if a vendor Opus encoder rejects
        // 16 kHz PCM. It is still roughly 7x smaller than the source WAV.
        val aac = File(outputDir, "${artifact.artifactId}.m4a")
        return encode(
            source = source,
            wav = wav,
            destination = aac,
            mime = MediaFormat.MIMETYPE_AUDIO_AAC,
            muxerFormat = MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4,
            bitRate = 48_000,
            codecName = "aac-lc",
            contentType = "audio/mp4",
            extension = "m4a",
        )
    }

    private fun encode(
        source: File,
        wav: WavInfo,
        destination: File,
        mime: String,
        muxerFormat: Int,
        bitRate: Int,
        codecName: String,
        contentType: String,
        extension: String,
    ): PreparedArtifact {
        require(wav.bitsPerSample == 16) { "Only 16-bit PCM WAV is supported" }
        destination.delete()
        val format = MediaFormat.createAudioFormat(mime, wav.sampleRate, wav.channels).apply {
            setInteger(MediaFormat.KEY_BIT_RATE, bitRate)
            setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 64 * 1024)
            if (mime == MediaFormat.MIMETYPE_AUDIO_AAC) {
                setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
            }
        }
        val codec = MediaCodec.createEncoderByType(mime)
        var muxer: MediaMuxer? = null
        var muxerStarted = false
        try {
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            codec.start()
            muxer = MediaMuxer(destination.absolutePath, muxerFormat)
            RandomAccessFile(source, "r").use { input ->
                input.seek(wav.dataOffset)
                val info = MediaCodec.BufferInfo()
                var remaining = wav.dataSize
                var submittedBytes = 0L
                var inputEnded = false
                var outputEnded = false
                var trackIndex = -1
                val bytesPerFrame = wav.channels * 2L

                while (!outputEnded) {
                    if (!inputEnded) {
                        val inputIndex = codec.dequeueInputBuffer(TIMEOUT_US)
                        if (inputIndex >= 0) {
                            val buffer = codec.getInputBuffer(inputIndex) ?: error("Encoder input buffer unavailable")
                            buffer.clear()
                            val wanted = minOf(buffer.remaining().toLong(), remaining).toInt()
                            val read = if (wanted > 0) readInto(input, buffer, wanted) else -1
                            if (read <= 0) {
                                val pts = submittedBytes / bytesPerFrame * 1_000_000L / wav.sampleRate
                                codec.queueInputBuffer(inputIndex, 0, 0, pts, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                                inputEnded = true
                            } else {
                                val aligned = read - (read % bytesPerFrame.toInt())
                                val pts = submittedBytes / bytesPerFrame * 1_000_000L / wav.sampleRate
                                codec.queueInputBuffer(inputIndex, 0, aligned, pts, 0)
                                submittedBytes += aligned
                                remaining -= aligned
                            }
                        }
                    }

                    when (val outputIndex = codec.dequeueOutputBuffer(info, TIMEOUT_US)) {
                        MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                            check(!muxerStarted) { "Encoder output format changed twice" }
                            trackIndex = muxer.addTrack(codec.outputFormat)
                            muxer.start()
                            muxerStarted = true
                        }
                        MediaCodec.INFO_TRY_AGAIN_LATER -> Unit
                        else -> if (outputIndex >= 0) {
                            val encoded = codec.getOutputBuffer(outputIndex) ?: error("Encoder output buffer unavailable")
                            if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) info.size = 0
                            if (info.size > 0) {
                                check(muxerStarted && trackIndex >= 0) { "Muxer was not ready" }
                                encoded.position(info.offset)
                                encoded.limit(info.offset + info.size)
                                muxer.writeSampleData(trackIndex, encoded, info)
                            }
                            outputEnded = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
                            codec.releaseOutputBuffer(outputIndex, false)
                        }
                    }
                }
            }
        } finally {
            runCatching { codec.stop() }
            codec.release()
            if (muxerStarted) runCatching { muxer?.stop() }
            runCatching { muxer?.release() }
        }
        require(destination.isFile && destination.length() > 0L) { "Encoder produced an empty file" }
        val durationMs = wav.dataSize / (wav.sampleRate * wav.channels * 2.0) * 1000.0
        return PreparedArtifact(
            path = destination.absolutePath,
            contentType = contentType,
            codec = codecName,
            extension = extension,
            bytes = destination.length(),
            sha256 = sha256(destination),
            durationMs = durationMs.toLong(),
        )
    }

    private fun readInto(input: RandomAccessFile, target: ByteBuffer, length: Int): Int {
        val temp = ByteArray(length)
        val read = input.read(temp)
        if (read > 0) target.put(temp, 0, read)
        return read
    }

    private fun readWavInfo(file: File): WavInfo = RandomAccessFile(file, "r").use { input ->
        require(readAscii(input, 4) == "RIFF" && readAscii(input.apply { seek(8) }, 4) == "WAVE") {
            "Invalid WAV header"
        }
        var sampleRate = 0
        var channels = 0
        var bits = 0
        var dataOffset = -1L
        var dataSize = -1L
        input.seek(12)
        while (input.filePointer + 8 <= input.length()) {
            val id = readAscii(input, 4)
            val size = readLeInt(input).toLong() and 0xffffffffL
            val start = input.filePointer
            when (id) {
                "fmt " -> {
                    val audioFormat = readLeShort(input)
                    channels = readLeShort(input)
                    sampleRate = readLeInt(input)
                    input.skipBytes(6)
                    bits = readLeShort(input)
                    require(audioFormat == 1) { "WAV is not PCM" }
                }
                "data" -> {
                    dataOffset = start
                    dataSize = minOf(size, input.length() - start)
                    break
                }
            }
            input.seek(start + size + (size and 1L))
        }
        require(sampleRate > 0 && channels > 0 && dataOffset >= 0 && dataSize >= 0) { "Incomplete WAV chunks" }
        WavInfo(sampleRate, channels, bits, dataOffset, dataSize)
    }

    private fun readAscii(input: RandomAccessFile, count: Int): String {
        val bytes = ByteArray(count)
        input.readFully(bytes)
        return String(bytes, Charsets.US_ASCII)
    }

    private fun readLeInt(input: RandomAccessFile): Int = Integer.reverseBytes(input.readInt())
    private fun readLeShort(input: RandomAccessFile): Int = java.lang.Short.reverseBytes(input.readShort()).toInt() and 0xffff

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().buffered().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read <= 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private const val TIMEOUT_US = 10_000L
}
