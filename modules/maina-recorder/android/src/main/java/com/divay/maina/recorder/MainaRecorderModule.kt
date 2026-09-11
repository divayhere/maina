package com.divay.maina.recorder

import android.app.ActivityManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.provider.Settings
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.RandomAccessFile

class MainaRecorderModule : Module() {
    private var triggerReceiverRegistered = false
    private var qwenAsr: MainaQwenAsr? = null
    private var modelPackLifecycle: MainaModelPackLifecycle? = null

    // Expo bridge values inside a Map arrive as Number (normally Double), not
    // necessarily a decimal String. Parsing through toString() made epoch
    // millisecond values such as meetingStartedAt disappear as 0 on retries.
    private fun mapLong(value: Any?): Long? = when (value) {
        is Number -> value.toLong()
        is String -> value.toLongOrNull() ?: value.toDoubleOrNull()?.toLong()
        else -> null
    }

    private fun mapInt(value: Any?): Int? = mapLong(value)?.toInt()

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
            // STOP/ABORT tokens are the only authority allowed to publish the
            // native service's finalizing state. JS may still mirror the three
            // non-terminal presentation states used by the legacy engine.
            require(state in setOf("idle", "recording", "paused")) { "Invalid capture state: $state" }
            val context = requireContext()
            startControlService(
                context,
                MainaRecordingService.ACTION_SET_STATE,
                mapOf(MainaRecordingService.EXTRA_CAPTURE_STATE to state),
            )
            Unit
        }

        AsyncFunction("consumeAndroidQualificationSession") { runId: String ->
            MainaQualificationSessionAuthority.consume(requireContext(), runId)
        }

        AsyncFunction("beginAndroidQualificationDiagnostics") { meetingId: String, evidenceDigest: String ->
            DiagnosticsStore.shared(requireContext()).beginQualificationSession(meetingId, evidenceDigest)
        }

        AsyncFunction("cancelAndroidQualificationDiagnosticsBeforeCapture") { meetingId: String, evidenceDigest: String ->
            val control = MainaCaptureControlStore(requireContext()).inspect()
            control == MainaCaptureControlInspection.Absent &&
                DiagnosticsStore.shared(requireContext()).cancelQualificationReservation(meetingId, evidenceDigest)
        }

        AsyncFunction("isAndroidQualificationSessionActive") {
            val context = requireContext()
            val controls = MainaCaptureControlStore(context).inspect()
            val diagnostics = DiagnosticsStore.shared(context)
            if (diagnostics.qualificationRecoveryAction(controls) in setOf(
                    MainaQualificationRecoveryAction.CANCEL_RESERVATION,
                    MainaQualificationRecoveryAction.COMPLETE_TERMINAL,
                )
            ) {
                diagnostics.reconcileAbsentCaptureControl()
            }
            diagnostics.isQualificationSessionActive() || when (controls) {
                is MainaCaptureControlInspection.Active -> controls.control.qualificationSession
                is MainaCaptureControlInspection.Terminal -> controls.control.qualificationSession
                is MainaCaptureControlInspection.Quarantined -> false
                MainaCaptureControlInspection.Absent -> false
                MainaCaptureControlInspection.Invalid ->
                    throw IllegalStateException("Durable capture ownership is invalid")
            }
        }

        // These calls are deliberately separate from Expo SpeechRecognizer.
        // They are the staged bridge for the service-owned AudioRecord engine.
        AsyncFunction("startNativeCapture") { meetingId: String, directory: String, sourceMode: String, chunkDurationMs: Long, meetingStartedAt: Long, qualificationSession: Boolean, qualificationEvidenceDigest: String? ->
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
                qualificationSession = qualificationSession,
                qualificationEvidenceDigest = qualificationEvidenceDigest,
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

        Function("prepareNativeDiscard") { meetingId: String, discardId: String ->
            val store = MainaCaptureControlStore(requireContext())
            when (val result = store.prepareDiscard(
                meetingId,
                discardId,
                MainaRecordingService::latchReadsOffForPreparedDiscardIfRunning,
            )) {
                is MainaDiscardPreparation.Prepared -> mapOf(
                    "prepared" to true,
                    "state" to if (result.control.terminalEffectReady) "ready_for_ack" else "pending",
                    "meetingId" to result.control.meetingId,
                    "discardId" to result.control.terminalDiscardId,
                    "directory" to result.control.directory,
                    "qualificationEvidenceDigest" to result.control.qualificationEvidenceDigest,
                    "generation" to result.control.generation,
                )
                MainaDiscardPreparation.NoCapture -> mapOf("prepared" to false, "state" to "none")
                MainaDiscardPreparation.Blocked -> mapOf("prepared" to false, "state" to "blocked")
            }
        }

        Function("getPendingNativeDiscard") {
            when (val inspection = MainaCaptureControlStore(requireContext()).inspect()) {
                MainaCaptureControlInspection.Absent -> mapOf("state" to "none")
                MainaCaptureControlInspection.Invalid -> mapOf("state" to "blocked")
                is MainaCaptureControlInspection.Active -> mapOf("state" to "none")
                is MainaCaptureControlInspection.Quarantined -> mapOf("state" to "none")
                is MainaCaptureControlInspection.Terminal -> if (
                    inspection.control.terminalDisposition == MainaCaptureTerminalDisposition.DISCARD &&
                    inspection.control.terminalDiscardId != null
                ) {
                    mapOf(
                        "state" to if (inspection.control.terminalEffectReady) "ready_for_ack" else "pending",
                        "meetingId" to inspection.control.meetingId,
                        "discardId" to inspection.control.terminalDiscardId,
                        "directory" to inspection.control.directory,
                        "qualificationEvidenceDigest" to inspection.control.qualificationEvidenceDigest,
                        "generation" to inspection.control.generation,
                    )
                } else {
                    mapOf("state" to "none")
                }
            }
        }

        Function("getNativeCaptureQuarantine") {
            when (val inspection = MainaCaptureControlStore(requireContext()).inspect()) {
                is MainaCaptureControlInspection.Quarantined -> mapOf(
                    "state" to "legacy_terminal",
                    "meetingId" to inspection.control.meetingId,
                    "reason" to "legacy_terminal_disposition_missing",
                )
                MainaCaptureControlInspection.Invalid -> mapOf("state" to "blocked")
                else -> mapOf("state" to "none")
            }
        }

        AsyncFunction("recoverNativeCaptureQuarantine") { meetingId: String ->
            val recovered = MainaCaptureControlStore(requireContext()).recoverQuarantinedAsSave(
                meetingId,
                MainaRecordingService::latchReadsOffForPreparedDiscardIfRunning,
            )
            if (recovered != null) {
                startControlService(
                    requireContext(),
                    MainaRecordingService.ACTION_RECONCILE_QUARANTINED_CAPTURE,
                    mapOf(
                        MainaRecordingService.EXTRA_MEETING_ID to recovered.meetingId,
                        MainaRecordingService.EXTRA_CAPTURE_GENERATION to recovered.generation.toString(),
                    ),
                )
            }
            mapOf("requested" to (recovered != null))
        }

        AsyncFunction("abortNativeCapture") { meetingId: String, discardId: String ->
            startControlService(
                requireContext(),
                MainaRecordingService.ACTION_ABORT_NATIVE_CAPTURE,
                mapOf(
                    MainaRecordingService.EXTRA_MEETING_ID to meetingId,
                    MainaRecordingService.EXTRA_DISCARD_ID to discardId,
                ),
            )
            mapOf("requested" to true)
        }

        AsyncFunction("acknowledgeNativeDiscard") { meetingId: String, discardId: String ->
            startControlService(
                requireContext(),
                MainaRecordingService.ACTION_ACKNOWLEDGE_NATIVE_DISCARD,
                mapOf(
                    MainaRecordingService.EXTRA_MEETING_ID to meetingId,
                    MainaRecordingService.EXTRA_DISCARD_ID to discardId,
                ),
            )
            mapOf("requested" to true)
        }

        AsyncFunction("retryNativeCaptureFinalization") {
            startControlService(requireContext(), MainaRecordingService.ACTION_RETRY_TERMINAL_NATIVE_CAPTURE)
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
                mapLong(request["captureEndedAt"])?.let {
                    putExtra(MainaPostProcessingService.EXTRA_CAPTURE_ENDED_AT, it)
                }
                mapLong(request["wallDurationMs"])?.let {
                    putExtra(MainaPostProcessingService.EXTRA_WALL_DURATION_MS, it)
                }
                mapLong(request["audioDurationMs"])?.let {
                    putExtra(MainaPostProcessingService.EXTRA_AUDIO_DURATION_MS, it)
                }
                mapInt(request["routeRestartCount"])?.let {
                    putExtra(MainaPostProcessingService.EXTRA_ROUTE_RESTART_COUNT, it)
                }
                mapLong(request["captureGapMs"])?.let {
                    putExtra(MainaPostProcessingService.EXTRA_CAPTURE_GAP_MS, it)
                }
                mapLong(request["meetingStartedAt"])?.let {
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
            val result = MainaPostProcessingOutbox.shared(requireContext()).read(meetingId)
                ?: return@AsyncFunction null
            if (result["state"] !in setOf(
                    MainaPostProcessingOutbox.STATE_COMPLETE,
                    MainaPostProcessingOutbox.STATE_PARTIAL,
                )
            ) return@AsyncFunction result
            val lifecycle = modelPacks()
            val payloadSha = lifecycle.resultPayloadSha256(result)
            val resultId = lifecycle.resultIdForPayloadSha256(payloadSha)
                ?: throw IllegalStateException("NATIVE_MODEL_RESULT_BINDING_FAILED")
            val activationGeneration = (result["modelActivationGeneration"] as? Number)?.toLong()
            val bound = lifecycle.noteExactResult(
                modelId = result["modelId"] as? String ?: "",
                modelVersion = result["modelVersion"] as? String ?: "",
                runtimeVersion = result["runtimeVersion"] as? String ?: "",
                manifestSha256 = result["modelManifestSha256"] as? String,
                activationGeneration = activationGeneration,
                resultId = resultId,
                resultPayloadSha256 = payloadSha,
            )
            if (!bound) throw IllegalStateException("NATIVE_MODEL_RESULT_BINDING_FAILED")
            result + mapOf("resultId" to resultId, "resultPayloadSha256" to payloadSha)
        }

        Function("isNativePostProcessingServiceRunning") {
            val manager = requireContext().getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            @Suppress("DEPRECATION")
            manager.getRunningServices(Int.MAX_VALUE).any {
                it.service.className == MainaPostProcessingService::class.java.name
            }
        }

        AsyncFunction("acknowledgeNativePostProcessingResult") { meetingId: String, runId: String ->
            mapOf(
                "acknowledged" to MainaPostProcessingOutbox.shared(requireContext())
                    .acknowledge(meetingId, runId),
            )
        }

        AsyncFunction("schedulePipelineWake") {
                generation: Long,
                requiresNetwork: Boolean,
                notBeforeAt: Long,
                scheduleRevision: Long,
                previousWorkId: String?,
                previousNotBeforeAt: Long?,
                previousScheduleRevision: Long?,
                schedulerProtocolVersion: Int,
            ->
            if (schedulerProtocolVersion != 2) {
                return@AsyncFunction mapOf(
                    "scheduled" to false,
                    "workId" to previousWorkId,
                    "errorCode" to "unsupported_scheduler_protocol",
                )
            }
            val result = MainaPipelineWakeScheduler.enqueueShared(
                requireContext(), generation, requiresNetwork, notBeforeAt,
                scheduleRevision, previousWorkId, previousNotBeforeAt,
                previousScheduleRevision,
            )
            mapOf(
                "scheduled" to result.scheduled,
                "workId" to result.workId,
                "errorCode" to result.errorCode,
            )
        }

        AsyncFunction("completePipelineWake") { attemptToken: String, succeeded: Boolean ->
            mapOf("completed" to MainaPipelineWakeCompletion.complete(attemptToken, succeeded))
        }

        AsyncFunction("isPipelineWakeAttemptActive") { attemptToken: String ->
            mapOf("active" to MainaPipelineWakeCompletion.isActive(attemptToken))
        }

        Function("getNativeCaptureStatus") {
            MainaRecordingService.nativeCaptureStatus
        }

        AsyncFunction("inspectNativeCaptureDirectory") { directory: String, recoverPartials: Boolean ->
            MainaNativeAudioCapture.inspectDirectory(directory, recoverPartials).asMap()
        }

        AsyncFunction("deleteNativeCaptureDirectory") { directory: String ->
            MainaNativeAudioCapture.deleteCaptureDirectory(directory)
        }

        AsyncFunction("deleteNativeDiscardDirectory") { meetingId: String, directory: String ->
            val store = MainaCaptureControlStore(requireContext())
            store.captureDirectoryMatchesMeeting(meetingId, directory) &&
                MainaNativeAudioCapture.deleteCaptureDirectory(directory)
        }

        AsyncFunction("getQwenAsrStatus") {
            qwen().status().asMap()
        }

        AsyncFunction("getNativeModelPackLifecycleStatus") {
            modelPacks().status().asMap()
        }

        AsyncFunction("beginNativeModelPackAcquisition") { manifestJson: String, partialOverheadBytes: Long, safetyMarginBytes: Long ->
            modelPacks().begin(manifestJson, partialOverheadBytes, safetyMarginBytes).asMap()
        }

        AsyncFunction("stageNativeModelPackChunk") { manifestJson: String, relativePath: String, chunkIndex: Int, sourceUri: String ->
            modelPacks().stageChunk(manifestJson, relativePath, chunkIndex, sourceUri).asMap()
        }

        AsyncFunction("verifyAndPromoteNativeModelPack") { manifestJson: String, smokeInputUri: String ->
            val lifecycle = modelPacks()
            lifecycle.verifyStaged(manifestJson)
            val evidence = qwen().smoke(lifecycle.smokeRoot(manifestJson), smokeInputUri)
            lifecycle.promote(manifestJson, evidence).asMap()
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
    private fun modelPacks(): MainaModelPackLifecycle =
        modelPackLifecycle ?: MainaModelPackLifecycle(requireContext()).also { modelPackLifecycle = it }

    private fun startControlService(
        context: Context,
        action: String,
        extras: Map<String, String> = emptyMap(),
        qualificationSession: Boolean? = null,
        qualificationEvidenceDigest: String? = null,
    ) {
        val intent = Intent(context, MainaRecordingService::class.java).setAction(action)
        extras.forEach { (key, value) -> intent.putExtra(key, value) }
        qualificationSession?.let { intent.putExtra(MainaRecordingService.EXTRA_QUALIFICATION_SESSION, it) }
        qualificationEvidenceDigest?.let {
            intent.putExtra(MainaRecordingService.EXTRA_QUALIFICATION_EVIDENCE_DIGEST, it)
        }
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
        ContextCompat.registerReceiver(
            context,
            triggerReceiver,
            filter,
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
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
