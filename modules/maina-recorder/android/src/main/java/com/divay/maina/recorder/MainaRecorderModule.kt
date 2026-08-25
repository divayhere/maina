package com.divay.maina.recorder

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.RandomAccessFile

class MainaRecorderModule : Module() {
    private var triggerReceiverRegistered = false
    private var qwenAsr: MainaQwenAsr? = null

    private val triggerReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                MainaHardwareTrigger.ACTION_TRIGGER -> {
                    context?.let { MainaHardwareTrigger.noteReceived(it, intent) }
                    sendEvent(
                        "onHardwareTrigger",
                        mapOf(
                            "command" to (intent.getStringExtra(MainaHardwareTrigger.EXTRA_COMMAND) ?: "toggle"),
                            "commandId" to (intent.getStringExtra(MainaHardwareTrigger.EXTRA_COMMAND_ID) ?: ""),
                            "source" to (intent.getStringExtra(MainaHardwareTrigger.EXTRA_SOURCE) ?: "unknown"),
                            "keyCode" to intent.getIntExtra(MainaHardwareTrigger.EXTRA_KEY_CODE, -1),
                            "deviceId" to intent.getIntExtra(MainaHardwareTrigger.EXTRA_DEVICE_ID, -1),
                            "deviceName" to (intent.getStringExtra(MainaHardwareTrigger.EXTRA_DEVICE_NAME) ?: "unknown"),
                            "occurredAt" to intent.getLongExtra(MainaHardwareTrigger.EXTRA_OCCURRED_AT, System.currentTimeMillis()),
                        ),
                    )
                }
                MainaAudioRouteBridge.ACTION_ROUTE_CHANGED -> sendEvent(
                    "onAudioRouteChanged",
                    mapOf(
                        "change" to (intent.getStringExtra(MainaAudioRouteBridge.EXTRA_CHANGE) ?: "unknown"),
                        "deviceId" to intent.getIntExtra(MainaAudioRouteBridge.EXTRA_DEVICE_ID, -1),
                        "deviceType" to intent.getIntExtra(MainaAudioRouteBridge.EXTRA_DEVICE_TYPE, -1),
                        "deviceName" to (intent.getStringExtra(MainaAudioRouteBridge.EXTRA_DEVICE_NAME) ?: "unknown"),
                        "occurredAt" to intent.getLongExtra(MainaAudioRouteBridge.EXTRA_OCCURRED_AT, System.currentTimeMillis()),
                    ),
                )
                MainaPostProcessingService.ACTION_RESULT_CHANGED -> sendEvent(
                    "onNativePostProcessingChanged",
                    mapOf(
                        "meetingId" to intent.getStringExtra(MainaPostProcessingService.EXTRA_MEETING_ID).orEmpty(),
                        "state" to intent.getStringExtra("state").orEmpty(),
                        "occurredAt" to System.currentTimeMillis(),
                    ),
                )
            }
        }
    }

    override fun definition() = ModuleDefinition {
        Name("MainaRecorder")
        Events("onHardwareTrigger", "onAudioRouteChanged", "onNativePostProcessingChanged")

        OnCreate {
            registerTriggerReceiver()
        }

        OnDestroy {
            unregisterTriggerReceiver()
            qwenAsr?.release()
            qwenAsr = null
        }

        AsyncFunction("startForegroundSession") {
            val context = requireContext()
            startControlService(context, MainaRecordingService.ACTION_ARM)
            true
        }

        AsyncFunction("stopForegroundSession") {
            val context = requireContext()
            startControlService(
                context,
                MainaRecordingService.ACTION_SET_STATE,
                mapOf(MainaRecordingService.EXTRA_CAPTURE_STATE to "idle"),
            )
            Unit
        }

        AsyncFunction("armRemoteControl") {
            val context = requireContext()
            startControlService(context, MainaRecordingService.ACTION_ARM)
            MainaHardwareTrigger.status(context)
        }

        AsyncFunction("disarmRemoteControl") {
            requireContext().stopService(Intent(requireContext(), MainaRecordingService::class.java))
            Unit
        }

        AsyncFunction("setCaptureState") { state: String ->
            require(state in setOf("idle", "recording", "paused", "finalizing")) { "Invalid capture state: $state" }
            val context = requireContext()
            startControlService(
                context,
                MainaRecordingService.ACTION_SET_STATE,
                mapOf(MainaRecordingService.EXTRA_CAPTURE_STATE to state),
            )
            Unit
        }

        // These calls are deliberately separate from Expo SpeechRecognizer.
        // They are the staged bridge for the service-owned AudioRecord engine.
        AsyncFunction("startNativeCapture") { meetingId: String, directory: String, sourceMode: String, chunkDurationMs: Long, meetingStartedAt: Long ->
            require(meetingId.isNotBlank()) { "meetingId is required" }
            require(directory.isNotBlank()) { "directory is required" }
            startControlService(
                requireContext(),
                MainaRecordingService.ACTION_START_NATIVE_CAPTURE,
                mapOf(
                    MainaRecordingService.EXTRA_MEETING_ID to meetingId,
                    MainaRecordingService.EXTRA_CAPTURE_DIRECTORY to directory,
                    MainaRecordingService.EXTRA_SOURCE_MODE to sourceMode,
                    MainaRecordingService.EXTRA_CHUNK_DURATION_MS to chunkDurationMs.toString(),
                    MainaRecordingService.EXTRA_MEETING_STARTED_AT to meetingStartedAt.toString(),
                ),
            )
            mapOf("requested" to true)
        }

        AsyncFunction("pauseNativeCapture") {
            startControlService(requireContext(), MainaRecordingService.ACTION_PAUSE_NATIVE_CAPTURE)
            mapOf("requested" to true)
        }

        AsyncFunction("resumeNativeCapture") {
            startControlService(requireContext(), MainaRecordingService.ACTION_RESUME_NATIVE_CAPTURE)
            mapOf("requested" to true)
        }

        AsyncFunction("stopNativeCapture") {
            startControlService(requireContext(), MainaRecordingService.ACTION_STOP_NATIVE_CAPTURE)
            mapOf("requested" to true)
        }

        AsyncFunction("abortNativeCapture") {
            startControlService(requireContext(), MainaRecordingService.ACTION_ABORT_NATIVE_CAPTURE)
            mapOf("requested" to true)
        }

        AsyncFunction("startNativePostProcessing") { request: Map<String, Any?> ->
            val meetingId = request["meetingId"]?.toString().orEmpty()
            val directory = request["directory"]?.toString().orEmpty()
            require(meetingId.isNotBlank()) { "meetingId is required" }
            require(directory.isNotBlank()) { "directory is required" }
            val intent = Intent(requireContext(), MainaPostProcessingService::class.java).apply {
                action = MainaPostProcessingService.ACTION_START
                putExtra(MainaPostProcessingService.EXTRA_MEETING_ID, meetingId)
                putExtra(MainaPostProcessingService.EXTRA_DIRECTORY, directory)
                putExtra(
                    MainaPostProcessingService.EXTRA_FORCE_RETRY,
                    request["forceRetry"] as? Boolean ?: false,
                )
                request["captureEndedAt"]?.toString()?.toLongOrNull()?.let {
                    putExtra(MainaPostProcessingService.EXTRA_CAPTURE_ENDED_AT, it)
                }
                request["wallDurationMs"]?.toString()?.toLongOrNull()?.let {
                    putExtra(MainaPostProcessingService.EXTRA_WALL_DURATION_MS, it)
                }
                request["audioDurationMs"]?.toString()?.toLongOrNull()?.let {
                    putExtra(MainaPostProcessingService.EXTRA_AUDIO_DURATION_MS, it)
                }
                request["routeRestartCount"]?.toString()?.toIntOrNull()?.let {
                    putExtra(MainaPostProcessingService.EXTRA_ROUTE_RESTART_COUNT, it)
                }
                request["captureGapMs"]?.toString()?.toLongOrNull()?.let {
                    putExtra(MainaPostProcessingService.EXTRA_CAPTURE_GAP_MS, it)
                }
                request["meetingStartedAt"]?.toString()?.toLongOrNull()?.let {
                    putExtra(MainaPostProcessingService.EXTRA_MEETING_STARTED_AT, it)
                }
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                requireContext().startForegroundService(intent)
            } else {
                requireContext().startService(intent)
            }
            mapOf("requested" to true)
        }

        AsyncFunction("readNativePostProcessingResult") { meetingId: String ->
            MainaPostProcessingOutbox.shared(requireContext()).read(meetingId)
        }

        AsyncFunction("acknowledgeNativePostProcessingResult") { meetingId: String, runId: String ->
            mapOf(
                "acknowledged" to MainaPostProcessingOutbox.shared(requireContext())
                    .acknowledge(meetingId, runId),
            )
        }

        Function("getNativeCaptureStatus") {
            MainaRecordingService.nativeCaptureStatus
        }

        AsyncFunction("inspectNativeCaptureDirectory") { directory: String, recoverPartials: Boolean ->
            MainaNativeAudioCapture.inspectDirectory(directory, recoverPartials).asMap()
        }

        AsyncFunction("getQwenAsrStatus") {
            qwen().status().asMap()
        }

        AsyncFunction("transcribeWithQwen") { uri: String, startMs: Long, endMs: Long ->
            qwen().transcribe(uri, startMs, endMs).asMap()
        }

        AsyncFunction("releaseQwenAsr") {
            qwenAsr?.release()
            qwenAsr = null
            Unit
        }

        AsyncFunction("getRemoteControlStatus") {
            MainaHardwareTrigger.status(requireContext())
        }

        AsyncFunction("openRemoteAccessibilitySettings") {
            val context = requireContext()
            context.startActivity(
                Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            Unit
        }

        AsyncFunction("acknowledgeHardwareTrigger") { commandId: String, action: String, accepted: Boolean ->
            MainaHardwareTrigger.acknowledge(requireContext(), commandId, action, accepted)
            Unit
        }

        Function("isForegroundSessionRunning") {
            MainaRecordingService.isRunning
        }

        AsyncFunction("repairWavFiles") { uris: List<String> ->
            uris.count { uri -> runCatching { repairWav(uri) }.getOrDefault(false) }
        }

        AsyncFunction("getPcmWavDurationsMs") { uris: List<String> ->
            uris.mapNotNull { uri ->
                runCatching { pcmWavDurationMs(uri) }.getOrNull()?.let { duration -> uri to duration }
            }.toMap()
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
            val store = DiagnosticsStore.shared(context)
            store.configure(config)
            DiagnosticsScheduler.ensurePeriodicWork(context)
            DiagnosticsScheduler.enqueueEvents(context)
            DiagnosticsScheduler.enqueueArtifacts(context)
            store.status()
        }

        AsyncFunction("enqueueDiagnosticEvents") { events: List<Map<String, Any?>> ->
            val context = requireContext()
            val store = DiagnosticsStore.shared(context)
            val inserted = store.enqueueEvents(events)
            val urgent = events.any { it["level"]?.toString() in setOf("error", "warn") }
            if (inserted > 0) DiagnosticsScheduler.enqueueEvents(context, urgent = urgent)
            inserted
        }

        AsyncFunction("queueAudioArtifact") { request: Map<String, Any?> ->
            val context = requireContext()
            val id = request["artifactId"]?.toString()?.takeIf { it.isNotBlank() }
                ?: "${request["meetingId"]}-audio-${request["segmentIndex"]}"
            DiagnosticsStore.shared(context).queueAudioArtifact(id, request)
            id
        }

        AsyncFunction("queueTextArtifact") { request: Map<String, Any?> ->
            val context = requireContext()
            val id = request["artifactId"]?.toString()?.takeIf { it.isNotBlank() }
                ?: "${request["meetingId"]}-${request["kind"]}-final"
            DiagnosticsStore.shared(context).queueTextArtifact(id, request)
            id
        }

        AsyncFunction("finalizeDiagnosticRun") { summary: Map<String, Any?> ->
            val context = requireContext()
            DiagnosticsStore.shared(context).finalizeRun(summary)
            DiagnosticsScheduler.enqueueEvents(context, urgent = true)
            DiagnosticsScheduler.enqueueArtifacts(context)
            Unit
        }

        AsyncFunction("flushDiagnostics") {
            DiagnosticsScheduler.enqueueEvents(requireContext(), replace = true)
            DiagnosticsScheduler.enqueueArtifacts(requireContext(), replace = true)
            Unit
        }

        AsyncFunction("retryFailedDiagnosticArtifacts") {
            val context = requireContext()
            val changed = DiagnosticsStore.shared(context).retryFailedArtifacts()
            if (changed > 0) DiagnosticsScheduler.enqueueArtifacts(context, replace = true)
            changed
        }

        AsyncFunction("getDiagnosticsStatus") {
            DiagnosticsStore.shared(requireContext()).status()
        }

        AsyncFunction("getMeetingsWithDeletedAudio") {
            DiagnosticsStore.shared(requireContext()).meetingsWithDeletedAudio()
        }

        AsyncFunction("purgeDiagnosticsData") {
            DiagnosticsStore.shared(requireContext()).purgeAllDiagnosticsData()
        }
    }

    private fun requireContext(): Context =
        appContext.reactContext ?: throw IllegalStateException("React context is unavailable")

    private fun qwen(): MainaQwenAsr = qwenAsr ?: MainaQwenAsr(requireContext()).also { qwenAsr = it }

    private fun startControlService(context: Context, action: String, extras: Map<String, String> = emptyMap()) {
        val intent = Intent(context, MainaRecordingService::class.java).setAction(action)
        extras.forEach { (key, value) -> intent.putExtra(key, value) }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
        else context.startService(intent)
    }

    private fun registerTriggerReceiver() {
        if (triggerReceiverRegistered) return
        val context = appContext.reactContext ?: return
        val filter = IntentFilter().apply {
            addAction(MainaHardwareTrigger.ACTION_TRIGGER)
            addAction(MainaAudioRouteBridge.ACTION_ROUTE_CHANGED)
            addAction(MainaPostProcessingService.ACTION_RESULT_CHANGED)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(triggerReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            context.registerReceiver(triggerReceiver, filter)
        }
        triggerReceiverRegistered = true
    }

    private fun unregisterTriggerReceiver() {
        if (!triggerReceiverRegistered) return
        runCatching { appContext.reactContext?.unregisterReceiver(triggerReceiver) }
        triggerReceiverRegistered = false
    }

    private fun repairWav(uri: String): Boolean {
        val file = mainaFileFromUriOrPath(uri)
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
        val file = mainaFileFromUriOrPath(uri)
        if (!file.isFile || file.length() < WAV_HEADER_BYTES) return null
        val pcmBytes = file.length() - WAV_HEADER_BYTES
        return pcmBytes * 1000L / PCM_BYTES_PER_SECOND
    }

    private fun writeLittleEndianInt(file: RandomAccessFile, value: Long) {
        require(value in 0..0xffffffffL) { "WAV file is too large" }
        file.writeInt(Integer.reverseBytes(value.toInt()))
    }

    private fun audioDeviceType(type: Int): String = when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_MIC -> "built-in microphone"
        AudioDeviceInfo.TYPE_USB_DEVICE -> "USB device"
        AudioDeviceInfo.TYPE_USB_HEADSET -> "USB headset"
        AudioDeviceInfo.TYPE_USB_ACCESSORY -> "USB audio accessory"
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "Bluetooth microphone"
        AudioDeviceInfo.TYPE_BLE_HEADSET -> "Bluetooth LE microphone"
        AudioDeviceInfo.TYPE_WIRED_HEADSET -> "wired headset"
        else -> "type-$type"
    }

    companion object {
        private const val WAV_HEADER_BYTES = 44L
        private const val PCM_BYTES_PER_SECOND = 16_000L * 1L * 2L
    }
}
