package com.divay.maina.recorder

import android.content.Context
import android.content.Intent
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.RandomAccessFile
import java.net.URI

class MainaRecorderModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("MainaRecorder")

        AsyncFunction("startForegroundSession") {
            val context = requireContext()
            val intent = Intent(context, MainaRecordingService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
            true
        }

        AsyncFunction("stopForegroundSession") {
            val context = requireContext()
            context.stopService(Intent(context, MainaRecordingService::class.java))
            Unit
        }

        Function("isForegroundSessionRunning") {
            MainaRecordingService.isRunning
        }

        AsyncFunction("repairWavFiles") { uris: List<String> ->
            uris.count { uri -> runCatching { repairWav(uri) }.getOrDefault(false) }
        }

        AsyncFunction("getPcmWavDurationsMs") { uris: List<String> ->
            uris.associateWith { uri -> runCatching { pcmWavDurationMs(uri) }.getOrNull() }
        }

        AsyncFunction("getAudioInputs") {
            val manager = requireContext().getSystemService(Context.AUDIO_SERVICE) as AudioManager
            manager.getDevices(AudioManager.GET_DEVICES_INPUTS).map { device ->
                mapOf(
                    "id" to device.id,
                    "name" to device.productName.toString(),
                    "type" to audioDeviceType(device.type),
                )
            }
        }

        AsyncFunction("configureDiagnostics") { config: Map<String, Any?> ->
            val context = requireContext()
            val store = DiagnosticsStore(context)
            try {
                store.configure(config)
                DiagnosticsScheduler.ensurePeriodicWork(context)
                DiagnosticsScheduler.enqueue(context)
                store.status()
            } finally {
                store.close()
            }
        }

        AsyncFunction("enqueueDiagnosticEvents") { events: List<Map<String, Any?>> ->
            val context = requireContext()
            val store = DiagnosticsStore(context)
            try {
                val inserted = store.enqueueEvents(events)
                if (inserted > 0) DiagnosticsScheduler.enqueue(context)
                inserted
            } finally {
                store.close()
            }
        }

        AsyncFunction("queueAudioArtifact") { request: Map<String, Any?> ->
            val context = requireContext()
            val id = request["artifactId"]?.toString()?.takeIf { it.isNotBlank() }
                ?: "${request["meetingId"]}-audio-${request["segmentIndex"]}"
            val store = DiagnosticsStore(context)
            try {
                store.queueAudioArtifact(id, request)
            } finally {
                store.close()
            }
            DiagnosticsScheduler.enqueue(context)
            id
        }

        AsyncFunction("queueTextArtifact") { request: Map<String, Any?> ->
            val context = requireContext()
            val id = request["artifactId"]?.toString()?.takeIf { it.isNotBlank() }
                ?: "${request["meetingId"]}-${request["kind"]}-final"
            val store = DiagnosticsStore(context)
            try {
                store.queueTextArtifact(id, request)
            } finally {
                store.close()
            }
            DiagnosticsScheduler.enqueue(context)
            id
        }

        AsyncFunction("finalizeDiagnosticRun") { summary: Map<String, Any?> ->
            val context = requireContext()
            val store = DiagnosticsStore(context)
            try {
                store.finalizeRun(summary)
            } finally {
                store.close()
            }
            DiagnosticsScheduler.enqueue(context)
            Unit
        }

        AsyncFunction("flushDiagnostics") {
            DiagnosticsScheduler.enqueue(requireContext(), replace = true)
            Unit
        }

        AsyncFunction("retryFailedDiagnosticArtifacts") {
            val context = requireContext()
            val store = DiagnosticsStore(context)
            val changed = try {
                store.retryFailedArtifacts()
            } finally {
                store.close()
            }
            if (changed > 0) DiagnosticsScheduler.enqueue(context, replace = true)
            changed
        }

        AsyncFunction("getDiagnosticsStatus") {
            val store = DiagnosticsStore(requireContext())
            try {
                store.status()
            } finally {
                store.close()
            }
        }

        AsyncFunction("getMeetingsWithDeletedAudio") {
            val store = DiagnosticsStore(requireContext())
            try {
                store.meetingsWithDeletedAudio()
            } finally {
                store.close()
            }
        }
    }

    private fun requireContext(): Context =
        appContext.reactContext ?: throw IllegalStateException("React context is unavailable")

    private fun repairWav(uri: String): Boolean {
        val file = fileFromUri(uri)
        if (!file.exists() || file.length() < 44L) return false
        RandomAccessFile(file, "rw").use { wav ->
            val signature = ByteArray(4)
            wav.readFully(signature)
            if (!signature.contentEquals("RIFF".toByteArray(Charsets.US_ASCII))) return false
            val dataLength = file.length() - 44L
            wav.seek(4L)
            writeLittleEndianInt(wav, 36L + dataLength)
            wav.seek(40L)
            writeLittleEndianInt(wav, dataLength)
        }
        return true
    }

    private fun pcmWavDurationMs(uri: String): Long? {
        val file = fileFromUri(uri)
        if (!file.isFile || file.length() < WAV_HEADER_BYTES) return null
        val pcmBytes = file.length() - WAV_HEADER_BYTES
        return pcmBytes * 1000L / PCM_BYTES_PER_SECOND
    }

    private fun fileFromUri(uri: String): File = when {
        uri.startsWith("file://") -> File(URI(uri))
        else -> File(uri)
    }

    private fun writeLittleEndianInt(file: RandomAccessFile, value: Long) {
        require(value in 0..0xffffffffL) { "WAV file is too large" }
        file.writeInt(Integer.reverseBytes(value.toInt()))
    }

    private fun audioDeviceType(type: Int): String = when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_MIC -> "built-in microphone"
        AudioDeviceInfo.TYPE_USB_DEVICE -> "USB device"
        AudioDeviceInfo.TYPE_USB_HEADSET -> "USB headset"
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "Bluetooth microphone"
        AudioDeviceInfo.TYPE_WIRED_HEADSET -> "wired headset"
        else -> "type-$type"
    }

    companion object {
        private const val WAV_HEADER_BYTES = 44L
        private const val PCM_BYTES_PER_SECOND = 16_000L * 1L * 2L
    }
}
