package com.divay.maina.recorder

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.AudioRecordingConfiguration
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Debug
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicLong

/**
 * Keeps Maina's process in Android's microphone foreground state while the
 * service-owned native capture engine owns AudioRecord. The persistent notification is intentional:
 * Android requires it for trustworthy screen-off microphone capture.
 */
class MainaRecordingService : Service() {
    private lateinit var audioManager: AudioManager
    private lateinit var mediaSession: MediaSession
    private var lastRecordingSignature: String? = null
    private val knownExternalInputIds = mutableSetOf<Int>()
    private val heartbeatHandler = Handler(Looper.getMainLooper())
    private val captureExecutor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "MainaCaptureCommands").apply { isDaemon = true }
    }
    private val captureOperationSequence = AtomicLong(0L)
    @Volatile private var latestCaptureOperation = 0L
    @Volatile private var acceptingNativeWork = true
    @Volatile private var destroyed = false
    private var destroyStopQueued = false
    private var activeCaptureOperation: MainaCaptureOperationToken? = null
    private lateinit var nativeCapture: MainaNativeAudioCapture
    private lateinit var captureControlStore: MainaCaptureControlStore
    @Volatile private var durableControl: MainaDurableCaptureControl? = null
    @Volatile private var lastCaptureMeetingId: String? = null
    @Volatile private var lastCaptureDirectory: String? = null
    @Volatile private var lastCaptureStartedAt: Long = 0L
    @Volatile private var postProcessingHandledMeetingId: String? = null
    @Volatile private var clientSilenced = false
    @Volatile private var controlState = MainaCaptureControlState()
    @Volatile private var communicationResumeScheduled = false
    @Volatile private var communicationResumeStartedAtMs = 0L
    @Volatile private var communicationResumeAttempts = 0
    private val serviceStartedAtMs = SystemClock.elapsedRealtime()
    private val heartbeatRunnable = object : Runnable {
        override fun run() {
            if (!isRunning) return
            if (captureState != "idle") emitServiceHeartbeat()
            heartbeatHandler.postDelayed(this, 60_000)
        }
    }
    private val communicationWatchRunnable = object : Runnable {
        override fun run() {
            if (!isRunning || destroyed) return
            if (!MainaCallInterruptionPolicy.shouldWatchCommunication(controlState)) return
            reconcileCommunicationInterruption()
            updateCommunicationWatch()
        }
    }
    private val modeChangedListener = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        AudioManager.OnModeChangedListener { reconcileCommunicationInterruption() }
    } else null

    private val recordingCallback = object : AudioManager.AudioRecordingCallback() {
        override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>?) {
            val candidates = configs.orEmpty().filter {
                it.clientAudioSource == android.media.MediaRecorder.AudioSource.VOICE_RECOGNITION
            }
            val signature = candidates.joinToString("|") { config ->
                val device = config.audioDevice
                listOf(
                    config.clientAudioSessionId,
                    config.clientAudioSource,
                    device?.id ?: -1,
                    device?.type ?: -1,
                    config.clientFormat.sampleRate,
                    config.clientFormat.channelCount,
                    config.format.sampleRate,
                    config.format.channelCount,
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) config.isClientSilenced else false,
                ).joinToString(":")
            }
            if (signature == lastRecordingSignature) return
            lastRecordingSignature = signature
            refreshedClientSilenced()
            reconcileCommunicationInterruption()
            candidates.forEach { config -> reportActiveRecording(config) }
        }
    }

    private val deviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) {
            addedDevices.filter(MainaAudioRouteBridge::isExternalMicrophone).forEach { device ->
                if (knownExternalInputIds.add(device.id)) reportDeviceChange("added", device)
            }
        }

        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) {
            removedDevices.filter(MainaAudioRouteBridge::isExternalMicrophone).forEach { device ->
                if (knownExternalInputIds.remove(device.id)) reportDeviceChange("removed", device)
            }
        }
    }

    companion object {
        const val CHANNEL_ID = "maina_recording"
        const val NOTIFICATION_ID = 7001
        const val ACTION_ARM = "com.divay.maina.recorder.ARM"
        const val ACTION_SET_STATE = "com.divay.maina.recorder.SET_STATE"
        const val ACTION_START_NATIVE_CAPTURE = "com.divay.maina.recorder.START_NATIVE_CAPTURE"
        const val ACTION_PAUSE_NATIVE_CAPTURE = "com.divay.maina.recorder.PAUSE_NATIVE_CAPTURE"
        const val ACTION_RESUME_NATIVE_CAPTURE = "com.divay.maina.recorder.RESUME_NATIVE_CAPTURE"
        const val ACTION_STOP_NATIVE_CAPTURE = "com.divay.maina.recorder.STOP_NATIVE_CAPTURE"
        const val ACTION_ABORT_NATIVE_CAPTURE = "com.divay.maina.recorder.ABORT_NATIVE_CAPTURE"
        const val EXTRA_CAPTURE_STATE = "captureState"
        const val EXTRA_MEETING_ID = "meetingId"
        const val EXTRA_CAPTURE_DIRECTORY = "captureDirectory"
        const val EXTRA_SOURCE_MODE = "sourceMode"
        const val EXTRA_CHUNK_DURATION_MS = "chunkDurationMs"
        const val EXTRA_MEETING_STARTED_AT = "meetingStartedAt"
        private val COMMUNICATION_RESUME_TOKEN = Any()
        private const val COMMUNICATION_WATCH_INTERVAL_MS = 500L

        @Volatile
        var isRunning: Boolean = false
            private set

        @Volatile
        var captureState: String = "idle"
            private set

        @Volatile
        var nativeCaptureStatus: Map<String, Any?> = mapOf("state" to "idle")
            private set
    }

    override fun onCreate() {
        super.onCreate()
        createChannel()
        audioManager = getSystemService(AudioManager::class.java)
        captureControlStore = MainaCaptureControlStore(this)
        nativeCapture = MainaNativeAudioCapture(
            context = this,
            onEvent = { level, eventName, payload ->
                recordNativeEvent(
                    level = level,
                    category = "native-capture",
                    eventName = eventName,
                    message = "Native capture event: $eventName",
                    payload = payload,
                )
                if (eventName == "native-capture-route-recovery-exhausted" || eventName == "native-capture-storage-reserve-reached") {
                    // The capture thread has already finalized the last WAV chunk.
                    // Queue the normal stop path on the service executor so it starts
                    // post-processing exactly once; never leave a silent recorder
                    // shown as live just because a physical input disappeared.
                    nativeCaptureStatus = payload + mapOf("state" to "error")
                    postMainOutcome {
                        if (captureState == "recording") {
                            setCaptureState("finalizing")
                            refreshForegroundUi()
                            onStartCommand(
                                Intent(this, MainaRecordingService::class.java).setAction(ACTION_STOP_NATIVE_CAPTURE),
                                0,
                                0,
                            )
                        }
                    }
                }
            },
            onStatus = { payload ->
                // This is a tiny volatile snapshot (4 Hz), not an event stream.
                // It gives the recording screen a truthful audio-level pulse even
                // while React/JS is busy and avoids persisting per-frame data.
                nativeCaptureStatus = nativeCaptureStatus + payload + mapOf(
                    "operationId" to nativeCaptureStatus["operationId"],
                )
            },
        )
        nativeCaptureStatus = mapOf("state" to "idle")
        restoreDurableCaptureControl()
        knownExternalInputIds += audioManager
            .getDevices(AudioManager.GET_DEVICES_INPUTS)
            .filter(MainaAudioRouteBridge::isExternalMicrophone)
            .map(AudioDeviceInfo::getId)
        audioManager.registerAudioRecordingCallback(recordingCallback, Handler(Looper.getMainLooper()))
        audioManager.registerAudioDeviceCallback(deviceCallback, Handler(Looper.getMainLooper()))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            modeChangedListener?.let { audioManager.addOnModeChangedListener(mainExecutor, it) }
        }
        mediaSession = MediaSession(this, "MainaRemoteControl").apply {
            setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS or MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS)
            setCallback(object : MediaSession.Callback() {
                override fun onMediaButtonEvent(mediaButtonIntent: Intent): Boolean {
                    val event = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, android.view.KeyEvent::class.java)
                    } else {
                        @Suppress("DEPRECATION")
                        mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)
                    } ?: return false
                    if (event.action != android.view.KeyEvent.ACTION_UP || event.repeatCount != 0) return true
                    when (event.keyCode) {
                        android.view.KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
                        android.view.KeyEvent.KEYCODE_HEADSETHOOK,
                        -> MainaHardwareTrigger.handlePrimaryPress(
                            this@MainaRecordingService,
                            "media-session",
                            event.keyCode,
                            event.deviceId,
                            android.view.InputDevice.getDevice(event.deviceId)?.name ?: "media remote",
                        )
                        android.view.KeyEvent.KEYCODE_MEDIA_STOP,
                        android.view.KeyEvent.KEYCODE_MEDIA_NEXT,
                        -> MainaHardwareTrigger.emit(this@MainaRecordingService, "stop", "media-session", event.keyCode, event.deviceId)
                        android.view.KeyEvent.KEYCODE_MEDIA_PLAY -> MainaHardwareTrigger.emit(this@MainaRecordingService, "start", "media-session", event.keyCode, event.deviceId)
                        android.view.KeyEvent.KEYCODE_MEDIA_PAUSE -> MainaHardwareTrigger.emit(this@MainaRecordingService, "pause", "media-session", event.keyCode, event.deviceId)
                        else -> return false
                    }
                    return true
                }

                override fun onPlay() {
                    MainaHardwareTrigger.emit(this@MainaRecordingService, "start", "media-session")
                }

                override fun onPause() {
                    MainaHardwareTrigger.emit(this@MainaRecordingService, "pause", "media-session")
                }

                override fun onStop() {
                    MainaHardwareTrigger.emit(this@MainaRecordingService, "stop", "media-session")
                }

                override fun onSkipToNext() {
                    MainaHardwareTrigger.emit(this@MainaRecordingService, "stop", "media-session-double")
                }
            })
            isActive = true
        }
        updateMediaState()
        heartbeatHandler.removeCallbacks(heartbeatRunnable)
        heartbeatHandler.postDelayed(heartbeatRunnable, 60_000)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (destroyed || !acceptingNativeWork) return START_NOT_STICKY
        MainaHardwareTrigger.commandForAction(intent?.action)?.let { command ->
            MainaHardwareTrigger.emit(this, command, "notification")
        }
        if (intent?.action == ACTION_SET_STATE) {
            val previousState = captureState
            captureState = intent.getStringExtra(EXTRA_CAPTURE_STATE)
                ?.takeIf { it in setOf("idle", "recording", "paused", "finalizing") }
                ?: captureState
            if (captureState != previousState) {
                vibrateTransition(previousState, captureState)
                recordNativeEvent(
                    level = "info",
                    category = "native-service",
                    eventName = "capture-state-changed",
                    message = "Recording service capture state changed",
                    payload = mapOf(
                        "previousState" to previousState,
                        "nextState" to captureState,
                        "serviceUptimeMs" to (SystemClock.elapsedRealtime() - serviceStartedAtMs),
                    ),
                )
                emitServiceHeartbeat()
            }
        }
        when (intent?.action) {
            ACTION_START_NATIVE_CAPTURE -> {
                if (!MainaCaptureOperationPolicy.startAdmissionAllowed(
                        controlState,
                        captureState,
                        operationActive = activeCaptureOperation != null,
                    )
                ) {
                    recordNativeEvent(
                        level = "warn",
                        category = "native-capture",
                        eventName = "capture-start-rejected-active-session",
                        message = "A new native capture was rejected while the current session is active",
                        payload = mapOf(
                            "phase" to controlState.phase.name.lowercase(),
                            "captureState" to captureState,
                        ),
                    )
                    refreshForegroundUi()
                    return START_STICKY
                }
                // Recording always wins the phone's CPU/memory budget. Stopping
                // the private ASR service interrupts its executor; the worker
                // checkpoints/defer at the next native decode boundary and the
                // durable outbox resumes it later without losing completed work.
                val postProcessingStopped = stopService(
                    Intent(this, MainaPostProcessingService::class.java),
                )
                if (postProcessingStopped) {
                    recordNativeEvent(
                        level = "info",
                        category = "native-asr",
                        eventName = "native-asr-preempted-for-capture",
                        message = "Recording preempted local transcription at a durable boundary",
                        payload = mapOf("postProcessingStopped" to true),
                    )
                }
                val meetingId = intent.getStringExtra(EXTRA_MEETING_ID).orEmpty()
                val directory = intent.getStringExtra(EXTRA_CAPTURE_DIRECTORY).orEmpty()
                val sourceMode = intent.getStringExtra(EXTRA_SOURCE_MODE) ?: "voice_recognition"
                val chunkDurationMs = intent.getStringExtra(EXTRA_CHUNK_DURATION_MS)?.toLongOrNull()
                    ?: intent.getLongExtra(EXTRA_CHUNK_DURATION_MS, 5 * 60_000L)
                val meetingStartedAt = intent.getStringExtra(EXTRA_MEETING_STARTED_AT)?.toLongOrNull()
                    ?: intent.getLongExtra(EXTRA_MEETING_STARTED_AT, System.currentTimeMillis())
                lastCaptureMeetingId = meetingId
                lastCaptureDirectory = directory
                lastCaptureStartedAt = meetingStartedAt
                postProcessingHandledMeetingId = null
                val startIntentState = MainaCaptureControlState(
                    phase = MainaCaptureControlPhase.PAUSE_PENDING,
                    pauseOwner = MainaCapturePauseOwner.SYSTEM,
                    generation = controlState.generation + 1L,
                    communicationActive = observedCommunicationActive(),
                )
                val startPersisted = runCatching {
                    captureControlStore.begin(
                        meetingId = meetingId,
                        directory = directory,
                        sourceMode = sourceMode,
                        chunkDurationMs = chunkDurationMs,
                        meetingStartedAt = meetingStartedAt,
                        state = startIntentState,
                    )
                }.getOrDefault(false)
                if (!startPersisted) {
                    controlState = MainaCaptureControlState()
                    nativeCaptureStatus = mapOf(
                        "state" to "error",
                        "meetingId" to meetingId,
                        "lastError" to "Could not persist capture start intent",
                    )
                    recordControlPersistenceFailure(
                        "capture-start-intent",
                        IllegalStateException("Could not persist capture start intent"),
                    )
                    setCaptureState("idle")
                } else {
                    durableControl = captureControlStore.read()
                    applyControlState(startIntentState)
                    val operation = issueCaptureOperation(
                        kind = MainaCaptureOperationKind.START,
                        owner = MainaCapturePauseOwner.SYSTEM,
                        expectedPhase = MainaCaptureControlPhase.PAUSE_PENDING,
                    )
                    nativeCaptureStatus = mapOf(
                        "state" to "starting",
                        "meetingId" to meetingId,
                        "sourceMode" to sourceMode,
                        "operationId" to operation.operationId,
                    )
                    dispatchPreparedCapture(
                        operation = operation,
                        pendingState = "starting",
                        committedEvent = "recording-owned",
                        publicationEvent = "capture-start-published",
                    ) {
                        nativeCapture.start(
                            MainaNativeAudioCapture.Options(
                                meetingId = meetingId,
                                directory = directory,
                                sourceMode = sourceMode,
                                chunkDurationMs = chunkDurationMs,
                            ),
                            operation.expectedPrivacyLatchGeneration
                                ?: error("Start privacy authority is unavailable"),
                        )
                    }
                }
            }
            ACTION_PAUSE_NATIVE_CAPTURE -> {
                cancelCommunicationRetryTimer()
                val decision = MainaCallInterruptionPolicy.onManualPause(controlState)
                if (decision is MainaCaptureControlDecision.Pause) {
                    var operation: MainaCaptureOperationToken? = null
                    val persistenceFailure = MainaCaptureSafetySequencer.latchApplyPersistThenQueue(
                        latch = nativeCapture::latchReadsOffNow,
                        apply = {
                            applyControlState(decision.state)
                            operation = issueCaptureOperation(
                                kind = MainaCaptureOperationKind.PAUSE,
                                owner = MainaCapturePauseOwner.MANUAL,
                                expectedPhase = MainaCaptureControlPhase.PAUSE_PENDING,
                            )
                        },
                        persist = { persistControlStateOrThrow(decision.state, "manual-pause-pending") },
                        queue = {
                            operation?.let {
                                dispatchNativePause(
                                    operation = it,
                                    pendingState = "pausing",
                                    completedEvent = "manual-paused",
                                    failedEvent = "manual-pause-checkpoint-timeout",
                                )
                            }
                        },
                    )
                    persistenceFailure?.let { recordControlPersistenceFailure("manual-pause-pending", it) }
                } else if (decision is MainaCaptureControlDecision.StateOnly &&
                    decision.state != controlState
                ) {
                    updateControlState(decision.state, "manual-pause-owned")
                }
            }
            ACTION_RESUME_NATIVE_CAPTURE -> {
                cancelCommunicationRetryTimer()
                val resumingSystemPause = controlState.pauseOwner == MainaCapturePauseOwner.SYSTEM
                when (val decision = MainaCallInterruptionPolicy.onManualResume(controlState)) {
                    is MainaCaptureControlDecision.Denied -> {
                        nativeCaptureStatus = nativeCapture.snapshot().asMap() + mapOf(
                            "state" to "paused",
                            "pauseReason" to controlState.pauseOwner.name.lowercase(),
                            "lastError" to "Recording stays paused while another communication session owns the microphone.",
                        )
                        refreshForegroundUi()
                    }
                    is MainaCaptureControlDecision.Resume -> {
                        if (updateControlState(decision.state, "manual-resume-pending")) {
                            val operation = issueCaptureOperation(
                                kind = MainaCaptureOperationKind.RESUME,
                                owner = MainaCapturePauseOwner.MANUAL,
                                expectedPhase = MainaCaptureControlPhase.RESUME_PENDING,
                            )
                            dispatchPreparedCapture(
                                operation = operation,
                                pendingState = "resuming",
                                committedEvent = "manual-resumed",
                                publicationEvent = "manual-resume-published",
                                failureEvent = "manual-resume-failed",
                            ) {
                                val generation = operation.expectedPrivacyLatchGeneration
                                    ?: error("Resume privacy authority is unavailable")
                                if (resumingSystemPause) {
                                    nativeCapture.resumeAfterCommunication(generation)
                                } else {
                                    nativeCapture.resume(generation)
                                }
                            }
                        } else {
                            failClosedResumeDurability(MainaCapturePauseOwner.MANUAL)
                        }
                    }
                    else -> Unit
                }
            }
            ACTION_STOP_NATIVE_CAPTURE -> {
                requestTerminalNativeStop(
                    MainaCaptureOperationKind.STOP,
                    "stop-requested",
                    abort = false,
                )
            }
            ACTION_ABORT_NATIVE_CAPTURE -> {
                requestTerminalNativeStop(
                    MainaCaptureOperationKind.ABORT,
                    "abort-requested",
                    abort = true,
                )
            }
        }
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        isRunning = true
        updateCommunicationWatch()
        updateMediaState()
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification)
        if (captureState != "idle") emitServiceHeartbeat()
        return START_STICKY
    }

    override fun onDestroy() {
        if (destroyed) {
            super.onDestroy()
            return
        }
        isRunning = false
        nativeCapture.latchReadsOffNow()
        invalidateCaptureControl("service-destroyed")
        acceptingNativeWork = false
        if (MainaCaptureLifecyclePolicy.shouldQueueDestroyStop(destroyStopQueued)) {
            destroyStopQueued = true
            try {
                captureExecutor.execute {
                    runCatching { nativeCaptureStatus = nativeCapture.stop().asMap() }
                }
            } catch (_: RejectedExecutionException) {
                // The immediate read latch already owns privacy. A duplicate or
                // late lifecycle callback must never enqueue after shutdown.
            }
        }
        captureExecutor.shutdown()
        destroyed = true
        heartbeatHandler.removeCallbacks(heartbeatRunnable)
        heartbeatHandler.removeCallbacks(communicationWatchRunnable)
        runCatching { audioManager.unregisterAudioRecordingCallback(recordingCallback) }
        runCatching { audioManager.unregisterAudioDeviceCallback(deviceCallback) }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            modeChangedListener?.let { listener ->
                runCatching { audioManager.removeOnModeChangedListener(listener) }
            }
        }
        runCatching { mediaSession.release() }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Maina controls",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Keeps Maina ready and shows meeting recording controls"
            setSound(null, null)
            enableVibration(false)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun setCaptureState(nextState: String) {
        val previousState = captureState
        captureState = nextState
        if (previousState == nextState) return
        vibrateTransition(previousState, nextState)
        recordNativeEvent(
            level = "info",
            category = "native-service",
            eventName = "capture-state-changed",
            message = "Recording service capture state changed",
            payload = mapOf(
                "previousState" to previousState,
                "nextState" to nextState,
                "serviceUptimeMs" to (SystemClock.elapsedRealtime() - serviceStartedAtMs),
            ),
        )
    }

    private data class NativeOutcome(
        val operation: MainaCaptureOperationToken,
        val snapshot: MainaNativeAudioCapture.Snapshot,
        val error: String? = null,
        val errorCode: String? = null,
        val published: Boolean = false,
        val safeAfterPublication: Boolean = false,
    )

    private fun requireMainReducer() {
        check(Looper.myLooper() == Looper.getMainLooper()) {
            "Capture reducer/token authority is main-looper only"
        }
    }

    private fun enqueueNativeWork(work: () -> Unit): Boolean {
        if (!MainaCaptureLifecyclePolicy.acceptsNativeWork(acceptingNativeWork, destroyed)) return false
        return try {
            captureExecutor.execute {
                if (MainaCaptureLifecyclePolicy.acceptsNativeWork(acceptingNativeWork, destroyed)) work()
            }
            true
        } catch (_: RejectedExecutionException) {
            false
        }
    }

    private fun postMainOutcome(work: () -> Unit) {
        if (!MainaCaptureLifecyclePolicy.acceptsNativeWork(acceptingNativeWork, destroyed)) return
        heartbeatHandler.post {
            if (MainaCaptureLifecyclePolicy.acceptsNativeWork(acceptingNativeWork, destroyed)) work()
        }
    }

    private fun issueCaptureOperation(
        kind: MainaCaptureOperationKind,
        owner: MainaCapturePauseOwner,
        expectedPhase: MainaCaptureControlPhase,
    ): MainaCaptureOperationToken {
        requireMainReducer()
        val operationId = captureOperationSequence.incrementAndGet()
        val operation = MainaCaptureOperationToken(
            operationId = operationId,
            generation = controlState.generation,
            owner = owner,
            kind = kind,
            expectedPhase = expectedPhase,
            captureSessionId = lastCaptureMeetingId,
            expectedPrivacyLatchGeneration = if (kind in setOf(
                    MainaCaptureOperationKind.START,
                    MainaCaptureOperationKind.RESUME,
                )
            ) {
                nativeCapture.privacyGenerationSnapshot()
            } else {
                null
            },
        )
        latestCaptureOperation = operationId
        activeCaptureOperation = operation
        return operation
    }

    private fun invalidateActiveOperation() {
        requireMainReducer()
        latestCaptureOperation = captureOperationSequence.incrementAndGet()
        activeCaptureOperation = null
    }

    private fun beginTerminalOperation(
        kind: MainaCaptureOperationKind,
        terminalState: MainaCaptureControlState,
    ): MainaCaptureOperationToken {
        require(kind == MainaCaptureOperationKind.STOP || kind == MainaCaptureOperationKind.ABORT)
        cancelCommunicationRetryTimer()
        invalidateActiveOperation()
        applyControlState(terminalState)
        return issueCaptureOperation(
            kind = kind,
            owner = MainaCapturePauseOwner.NONE,
            expectedPhase = MainaCaptureControlPhase.TERMINAL,
        )
    }

    private fun requestTerminalNativeStop(
        kind: MainaCaptureOperationKind,
        event: String,
        abort: Boolean,
        requestedTerminalState: MainaCaptureControlState? = null,
    ) {
        var operation: MainaCaptureOperationToken? = null
        var terminalState: MainaCaptureControlState? = null
        val persistenceFailure = MainaCaptureSafetySequencer.latchApplyPersistThenQueue(
            latch = nativeCapture::latchReadsOffNow,
            apply = {
                operation = beginTerminalOperation(
                    kind,
                    requestedTerminalState ?: MainaCallInterruptionPolicy.terminal(controlState),
                )
                terminalState = controlState
            },
            persist = {
                persistControlStateOrThrow(
                    terminalState ?: error("Terminal reducer state was not applied"),
                    event,
                )
            },
            queue = {
                operation?.let { dispatchNativeStop(it, abort) }
            },
        )
        persistenceFailure?.let { recordControlPersistenceFailure(event, it) }
        runCatching { setCaptureState("finalizing") }
    }

    private fun accepts(operation: MainaCaptureOperationToken): Boolean {
        requireMainReducer()
        return MainaCaptureOperationPolicy.accepts(
            activeCaptureOperation,
            operation,
            controlState,
            acceptingWork = MainaCaptureLifecyclePolicy.acceptsNativeWork(acceptingNativeWork, destroyed),
        )
    }

    private fun dispatchPreparedCapture(
        operation: MainaCaptureOperationToken,
        pendingState: String,
        committedEvent: String,
        publicationEvent: String,
        failureEvent: String = "capture-start-failed",
        nativeOperation: () -> MainaNativeAudioCapture.Snapshot,
    ) {
        nativeCaptureStatus = nativeCapture.snapshot().asMap() + mapOf(
            "state" to pendingState,
            "operationId" to operation.operationId,
        )
        val enqueued = enqueueNativeWork {
            val preparationAllowed = MainaCaptureOperationPolicy.nativePreparationAllowed(
                latestOperationId = latestCaptureOperation,
                operation = operation,
                currentPrivacyLatchGeneration = nativeCapture.privacyGenerationSnapshot(),
                communicationActive = observedCommunicationActive(),
                acceptingWork = MainaCaptureLifecyclePolicy.acceptsNativeWork(
                    acceptingNativeWork,
                    destroyed,
                ),
            )
            val result = if (preparationAllowed) {
                runCatching(nativeOperation)
            } else {
                Result.failure(IllegalStateException("Native preparation authority changed"))
            }
            if (result.isFailure && operation.kind == MainaCaptureOperationKind.START) {
                runCatching { nativeCapture.stop() }
            }
            val outcome = NativeOutcome(
                operation = operation,
                snapshot = result.getOrElse { nativeCapture.snapshot() },
                error = result.exceptionOrNull()?.let { it.message ?: it.javaClass.simpleName },
                errorCode = if (result.exceptionOrNull() is MainaNativeAudioCapture.SystemResumeWaitingException) {
                    "system-retained-recorder-waiting"
                } else {
                    null
                },
            )
            postMainOutcome {
                handlePreparedCaptureOutcome(outcome, committedEvent, publicationEvent, failureEvent)
            }
        }
        if (!enqueued && acceptingNativeWork && !destroyed) {
            handlePreparedCaptureOutcome(
                NativeOutcome(
                    operation = operation,
                    snapshot = nativeCapture.snapshot(),
                    error = "Native capture executor is unavailable",
                ),
                committedEvent,
                publicationEvent,
                failureEvent,
            )
        }
    }

    private fun handlePreparedCaptureOutcome(
        outcome: NativeOutcome,
        committedEvent: String,
        publicationEvent: String,
        failureEvent: String,
    ) {
        requireMainReducer()
        if (outcome.error != null) {
            if (outcome.errorCode == "system-retained-recorder-waiting" &&
                outcome.operation.owner == MainaCapturePauseOwner.SYSTEM &&
                accepts(outcome.operation)
            ) {
                activeCaptureOperation = null
                val paused = MainaCallInterruptionPolicy.resumeFailed(controlState)
                val persisted = updateControlState(paused, "system-retained-recorder-waiting")
                nativeCaptureStatus = outcome.snapshot.asMap() + mapOf(
                    "state" to "paused",
                    "pauseReason" to "system",
                    "recoveryReason" to outcome.errorCode,
                    "operationId" to outcome.operation.operationId,
                )
                refreshForegroundUi()
                if (persisted) scheduleCommunicationResume() else failClosedResumeDurability(MainaCapturePauseOwner.SYSTEM)
                return
            }
            nativeCaptureStatus = outcome.snapshot.asMap() + mapOf(
                "state" to "error",
                "lastError" to outcome.error,
                "operationId" to outcome.operation.operationId,
            )
            recordNativeEvent(
                level = "error",
                category = "native-capture",
                eventName = failureEvent,
                message = "Native capture could not acquire publication ownership",
                payload = mapOf(
                    "error" to outcome.error,
                    "operationId" to outcome.operation.operationId,
                ),
            )
            if (outcome.operation.kind == MainaCaptureOperationKind.START) {
                // START failure is authoritative even if a manual/system PAUSE
                // superseded its token while native acquisition was running. A
                // capture that never started cannot be exposed as PAUSED.
                if (MainaCaptureOperationPolicy.startFailureMustTerminalize(
                        outcome.operation.kind,
                        controlState,
                        MainaCaptureLifecyclePolicy.acceptsNativeWork(acceptingNativeWork, destroyed),
                        completionSessionId = outcome.operation.captureSessionId,
                        currentSessionId = lastCaptureMeetingId,
                    )
                ) {
                    invalidateActiveOperation()
                    updateControlState(MainaCallInterruptionPolicy.terminal(controlState), failureEvent)
                    captureControlStore.clear()
                    durableControl = null
                    setCaptureState("idle")
                }
            } else if (!accepts(outcome.operation)) {
                nativeCapture.latchReadsOffNow()
                queueNativePauseWithoutReducer("$failureEvent-stale-cleanup-timeout")
            } else if (MainaCaptureOperationPolicy.preparationFailureNeedsPause(outcome.operation.kind)) {
                // resume() can fail after acquiring AudioRecord. Do not expose a
                // PAUSED reducer or schedule recovery until the serialized native
                // checkpoint has actually succeeded; its failure terminalizes.
                pausePreparedCapture(
                    outcome.operation,
                    controlState.communicationActive,
                    "$failureEvent-cleanup",
                )
            } else {
                rollbackPreparedCapture(outcome.operation, failureEvent, communicationActive = controlState.communicationActive)
            }
            refreshForegroundUi()
            return
        }

        val communicationActive = observedCommunicationActive()
        if (!MainaCaptureOperationPolicy.publicationAllowed(
                activeCaptureOperation,
                outcome.operation,
                controlState,
                communicationActive,
            )
        ) {
            if (accepts(outcome.operation)) {
                pausePreparedCapture(outcome.operation, communicationActive, "$committedEvent-blocked")
            } else {
                nativeCapture.latchReadsOffNow()
                queueNativePauseWithoutReducer("$committedEvent-stale-cleanup-timeout")
            }
            return
        }
        dispatchNativePublication(outcome.operation, committedEvent, publicationEvent)
    }

    private fun dispatchNativePublication(
        operation: MainaCaptureOperationToken,
        committedEvent: String,
        publicationEvent: String,
    ) {
        val enqueued = enqueueNativeWork {
            val safeBefore = latestCaptureOperation == operation.operationId && !observedCommunicationActive()
            val result = if (safeBefore) {
                runCatching { nativeCapture.prepareRecordingOwnershipPublication(publicationEvent) }
            } else {
                Result.failure(IllegalStateException("Publication precondition changed"))
            }
            val published = result.isSuccess
            val safeAfter = published && latestCaptureOperation == operation.operationId && !observedCommunicationActive()
            if (!safeAfter) {
                // This is the immediate privacy latch only. The main reducer
                // issues the serialized, outcome-bearing pause after it decides
                // whether this token is still authoritative.
                nativeCapture.latchReadsOffNow()
            }
            val outcome = NativeOutcome(
                operation = operation,
                snapshot = nativeCapture.snapshot(),
                error = result.exceptionOrNull()?.let { it.message ?: it.javaClass.simpleName },
                published = published,
                safeAfterPublication = safeAfter,
            )
            postMainOutcome { handlePublicationOutcome(outcome, committedEvent) }
        }
        if (!enqueued && acceptingNativeWork && !destroyed) {
            handlePublicationOutcome(
                NativeOutcome(
                    operation = operation,
                    snapshot = nativeCapture.snapshot(),
                    error = "Native capture executor is unavailable",
                ),
                committedEvent,
            )
        }
    }

    private fun handlePublicationOutcome(outcome: NativeOutcome, committedEvent: String) {
        requireMainReducer()
        val operationAccepted = accepts(outcome.operation)
        val communicationActive = observedCommunicationActive()
        if (!operationAccepted || outcome.error != null || !outcome.safeAfterPublication || communicationActive) {
            nativeCapture.latchReadsOffNow()
            val event = if (outcome.error == null) {
                "$committedEvent-publication-blocked"
            } else {
                "$committedEvent-publication-failed"
            }
            if (!operationAccepted) {
                queueNativePauseWithoutReducer("$event-stale-cleanup-timeout")
                return
            }
            // A prepared recorder is not rolled back to PAUSED until its real
            // native checkpoint succeeds. That prevents a SYSTEM retry from
            // queuing behind a timed-out cleanup and reopening an unsafe chunk.
            pausePreparedCapture(outcome.operation, communicationActive, event)
            return
        }

        val recordingState = MainaCallInterruptionPolicy.resumeSucceeded(
            controlState.copy(communicationActive = false),
        )
        val durableCommit = runCatching {
            persistControlStateOrThrow(recordingState, committedEvent)
        }
        if (durableCommit.isFailure) {
            nativeCapture.latchReadsOffNow()
            recordControlPersistenceFailure(committedEvent, durableCommit.exceptionOrNull()!!)
            pausePreparedCapture(
                outcome.operation,
                communicationActive = false,
                event = "$committedEvent-durability-failed",
            )
            return
        }

        applyControlState(recordingState)
        nativeCaptureStatus = outcome.snapshot.asMap() + mapOf(
            "state" to "recording",
            "operationId" to outcome.operation.operationId,
        )
        communicationResumeStartedAtMs = 0L
        communicationResumeAttempts = 0
        nativeCaptureStatus = nativeCaptureStatus + mapOf("pauseReason" to null)
        val preEnableUi = runCatching {
            setCaptureState("recording")
            if (outcome.operation.kind == MainaCaptureOperationKind.RESUME &&
                outcome.operation.owner == MainaCapturePauseOwner.SYSTEM
            ) {
                recordNativeEvent(
                    level = "info",
                    category = "native-capture",
                    eventName = "native-capture-auto-resumed-after-communication",
                    message = "Capture resumed after the communication session ended",
                    payload = mapOf("audioMode" to audioManager.mode),
                )
            }
            refreshForegroundUi()
        }
        if (preEnableUi.isFailure) {
            nativeCapture.latchReadsOffNow()
            rollbackCommittedPublication(outcome.operation, "$committedEvent-ui-preparation-failed")
            return
        }

        // Main is the sole token/reducer authority, so no stop/call transition
        // can interleave between this final fresh check and the nonthrowing native
        // read latch. All durability and callbacks above completed with reads off.
        val communicationReacquired = observedCommunicationActive()
        if (!MainaCaptureOperationPolicy.enableAllowed(
                activeCaptureOperation,
                outcome.operation,
                controlState,
                communicationReacquired,
                acceptingWork = MainaCaptureLifecyclePolicy.acceptsNativeWork(acceptingNativeWork, destroyed),
            )
        ) {
            nativeCapture.latchReadsOffNow()
            rollbackCommittedPublication(outcome.operation, "$committedEvent-communication-reacquired")
            return
        }
        activeCaptureOperation = null
        if (nativeCapture.enablePreparedReads()) return
        rollbackCommittedPublication(outcome.operation, "$committedEvent-enable-failed")
    }

    private fun rollbackCommittedPublication(
        operation: MainaCaptureOperationToken,
        event: String,
    ) {
        nativeCapture.latchReadsOffNow()
        nativeCaptureStatus = nativeCapture.snapshot().asMap() + mapOf(
            "state" to "pausing",
            "pauseReason" to operation.owner.name.lowercase(),
            "operationId" to operation.operationId,
            "lastError" to "Capture publication was revoked before reads were enabled",
        )
        pausePreparedCapture(operation, observedCommunicationActive(), event)
    }

    private fun pausePreparedCapture(
        operation: MainaCaptureOperationToken,
        communicationActive: Boolean,
        event: String,
    ) {
        val changed = communicationActive != controlState.communicationActive
        val pending = controlState.copy(
            phase = MainaCaptureControlPhase.PAUSE_PENDING,
            pauseOwner = operation.owner,
            generation = controlState.generation + if (changed) 1L else 0L,
            communicationActive = communicationActive,
        )
        var pause: MainaCaptureOperationToken? = null
        val persistenceFailure = MainaCaptureSafetySequencer.latchApplyPersistThenQueue(
            latch = if (communicationActive && operation.owner == MainaCapturePauseOwner.SYSTEM) {
                nativeCapture::revokeSystemResumeForCommunicationReentryNow
            } else {
                nativeCapture::latchReadsOffNow
            },
            apply = {
                applyControlState(pending)
                pause = issueCaptureOperation(
                    kind = MainaCaptureOperationKind.PAUSE,
                    owner = operation.owner,
                    expectedPhase = MainaCaptureControlPhase.PAUSE_PENDING,
                )
            },
            persist = { persistControlStateOrThrow(pending, event) },
            queue = {
                pause?.let {
                    dispatchNativePause(it, "pausing", "$event-paused", "$event-checkpoint-timeout")
                }
            },
        )
        persistenceFailure?.let { recordControlPersistenceFailure(event, it) }
    }

    private fun rollbackPreparedCapture(
        operation: MainaCaptureOperationToken,
        event: String,
        communicationActive: Boolean,
    ) {
        if (!accepts(operation)) return
        val rollbackPersisted = updateControlState(
            controlState.copy(
                phase = MainaCaptureControlPhase.PAUSED,
                pauseOwner = operation.owner,
                communicationActive = communicationActive,
            ),
            event,
        )
        activeCaptureOperation = null
        clientSilenced = false
        nativeCaptureStatus = nativeCapture.snapshot().asMap() + mapOf(
            "state" to "paused",
            "pauseReason" to operation.owner.name.lowercase(),
            "operationId" to operation.operationId,
        )
        setCaptureState("paused")
        refreshForegroundUi()
        if (rollbackPersisted && operation.owner == MainaCapturePauseOwner.SYSTEM && !communicationActive) {
            scheduleCommunicationResume()
        }
    }

    private fun failClosedResumeDurability(owner: MainaCapturePauseOwner) {
        nativeCapture.latchReadsOffNow()
        activeCaptureOperation = null
        applyControlState(
            controlState.copy(
                phase = MainaCaptureControlPhase.PAUSED,
                pauseOwner = owner,
            ),
        )
        nativeCaptureStatus = nativeCapture.snapshot().asMap() + mapOf(
            "state" to "paused",
            "pauseReason" to owner.name.lowercase(),
            "lastError" to "Recording stays paused because control durability is unavailable",
        )
        runCatching {
            setCaptureState("paused")
            refreshForegroundUi()
        }
    }

    private fun dispatchNativePause(
        operation: MainaCaptureOperationToken,
        pendingState: String,
        completedEvent: String,
        failedEvent: String,
    ) {
        nativeCaptureStatus = nativeCapture.snapshot().asMap() + mapOf(
            "state" to pendingState,
            "operationId" to operation.operationId,
        )
        val enqueued = enqueueNativeWork {
            val result = runCatching {
                if (operation.owner == MainaCapturePauseOwner.SYSTEM) {
                    nativeCapture.pauseForCommunication()
                } else {
                    nativeCapture.pause()
                }
            }
            val outcome = NativeOutcome(
                operation = operation,
                snapshot = result.getOrElse { nativeCapture.snapshot() },
                error = result.exceptionOrNull()?.let { it.message ?: it.javaClass.simpleName },
            )
            postMainOutcome { handlePauseOutcome(outcome, completedEvent, failedEvent) }
        }
        if (!enqueued && acceptingNativeWork && !destroyed) {
            handlePauseOutcome(
                NativeOutcome(
                    operation = operation,
                    snapshot = nativeCapture.snapshot(),
                    error = "Native capture executor is unavailable",
                ),
                completedEvent,
                failedEvent,
            )
        }
    }

    private fun handlePauseOutcome(outcome: NativeOutcome, completedEvent: String, failedEvent: String) {
        requireMainReducer()
        if (outcome.error != null) {
            // Native pause has already latched reads off and released recorder
            // ownership. Failure cannot be hidden by a newer pause token: unless
            // Stop/Abort already owns terminal authority, finish this same capture.
            // A failed checkpoint never flows through onPauseCompleted
            // and therefore cannot auto-resume. Finish the meeting as a partial
            // save under terminal authority instead of reopening an uncertain
            // active chunk.
            if (MainaCaptureOperationPolicy.pauseFailureMustTerminalize(
                    controlState,
                    acceptingWork = MainaCaptureLifecyclePolicy.acceptsNativeWork(
                        acceptingNativeWork,
                        destroyed,
                    ),
                )
            ) {
                requestTerminalNativeStop(
                    kind = MainaCaptureOperationKind.STOP,
                    event = failedEvent,
                    abort = false,
                    requestedTerminalState = MainaCallInterruptionPolicy.pauseFailed(controlState),
                )
                nativeCaptureStatus = nativeCaptureStatus + mapOf(
                    "lastError" to outcome.error,
                )
            }
            return
        }
        if (!accepts(outcome.operation)) return
        clientSilenced = false
        val event = completedEvent
        when (val decision = MainaCallInterruptionPolicy.onPauseCompleted(controlState)) {
            is MainaCaptureControlDecision.Resume -> {
                val persisted = updateControlState(decision.state, event)
                activeCaptureOperation = null
                setCaptureState("paused")
                if (persisted) scheduleCommunicationResume() else failClosedResumeDurability(outcome.operation.owner)
            }
            is MainaCaptureControlDecision.StateOnly -> {
                updateControlState(decision.state, event)
                activeCaptureOperation = null
                setCaptureState("paused")
            }
            else -> return
        }
        nativeCaptureStatus = outcome.snapshot.asMap() + mapOf(
            "state" to "paused",
            "pauseReason" to outcome.operation.owner.name.lowercase(),
            "operationId" to outcome.operation.operationId,
            "lastError" to outcome.error,
        )
        refreshForegroundUi()
    }

    private fun queueNativePauseWithoutReducer(failedEvent: String) {
        val enqueued = enqueueNativeWork {
            val result = runCatching {
                nativeCapture.latchReadsOffNow()
                nativeCapture.pause()
            }
            val error = result.exceptionOrNull()?.let { it.message ?: it.javaClass.simpleName }
            if (error != null) {
                postMainOutcome { handleDetachedPauseFailure(error, failedEvent) }
            }
        }
        if (!enqueued && MainaCaptureLifecyclePolicy.acceptsNativeWork(acceptingNativeWork, destroyed)) {
            handleDetachedPauseFailure("Native capture executor is unavailable", failedEvent)
        }
    }

    private fun handleDetachedPauseFailure(error: String, failedEvent: String) {
        requireMainReducer()
        // Even a stale/no-reducer cleanup owns a real native checkpoint. Its
        // failure is safety-critical and cannot be hidden by a newer PAUSE or
        // RESUME token; only an existing terminal/destroy winner may suppress it.
        if (!MainaCaptureOperationPolicy.pauseFailureMustTerminalize(
                controlState,
                acceptingWork = MainaCaptureLifecyclePolicy.acceptsNativeWork(
                    acceptingNativeWork,
                    destroyed,
                ),
            )
        ) return
        requestTerminalNativeStop(
            kind = MainaCaptureOperationKind.STOP,
            event = failedEvent,
            abort = false,
            requestedTerminalState = MainaCallInterruptionPolicy.pauseFailed(controlState),
        )
        nativeCaptureStatus = nativeCaptureStatus + mapOf("lastError" to error)
    }

    private fun dispatchNativeStop(operation: MainaCaptureOperationToken, abort: Boolean) {
        nativeCaptureStatus = nativeCapture.snapshot().asMap() + mapOf(
            "state" to "finalizing",
            "operationId" to operation.operationId,
        )
        val enqueued = enqueueNativeWork {
            val result = runCatching { nativeCapture.stop() }
            val outcome = NativeOutcome(
                operation = operation,
                snapshot = result.getOrElse { nativeCapture.snapshot() },
                error = result.exceptionOrNull()?.let { it.message ?: it.javaClass.simpleName },
            )
            postMainOutcome { handleStopOutcome(outcome, abort) }
        }
        if (!enqueued && acceptingNativeWork && !destroyed) {
            handleStopOutcome(
                NativeOutcome(
                    operation = operation,
                    snapshot = nativeCapture.snapshot(),
                    error = "Native capture executor is unavailable",
                ),
                abort,
            )
        }
    }

    private fun handleStopOutcome(outcome: NativeOutcome, abort: Boolean) {
        requireMainReducer()
        if (!accepts(outcome.operation)) return
        if (outcome.error != null) {
            nativeCaptureStatus = outcome.snapshot.asMap() + mapOf(
                "state" to "error",
                "lastError" to outcome.error,
                "operationId" to outcome.operation.operationId,
            )
            refreshForegroundUi()
            return
        }
        activeCaptureOperation = null
        nativeCaptureStatus = outcome.snapshot.asMap() + mapOf("operationId" to outcome.operation.operationId)
        if (abort) handleAbortCompletion(outcome.snapshot) else handleStopCompletion(outcome.snapshot)
        setCaptureState("idle")
        refreshForegroundUi()
    }

    private fun handleStopCompletion(snapshot: MainaNativeAudioCapture.Snapshot) {
        val meetingId = snapshot.meetingId ?: lastCaptureMeetingId ?: return
        val directory = lastCaptureDirectory ?: return
        // Stop can arrive more than once. Only the accepted terminal operation
        // may hand this meeting to post-processing.
        if (postProcessingHandledMeetingId == meetingId) return
        postProcessingHandledMeetingId = meetingId
        val intent = Intent(this, MainaPostProcessingService::class.java).apply {
            action = MainaPostProcessingService.ACTION_START
            putExtra(MainaPostProcessingService.EXTRA_MEETING_ID, meetingId)
            putExtra(MainaPostProcessingService.EXTRA_DIRECTORY, directory)
            putExtra(MainaPostProcessingService.EXTRA_CAPTURE_ENDED_AT, System.currentTimeMillis())
            putExtra(MainaPostProcessingService.EXTRA_MEETING_STARTED_AT, lastCaptureStartedAt)
            putExtra(MainaPostProcessingService.EXTRA_ROUTE_RESTART_COUNT, snapshot.routeRestartCount)
            putExtra(MainaPostProcessingService.EXTRA_CAPTURE_GAP_MS, snapshot.captureGapMs)
        }
        val launch = runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent) else startService(intent)
        }
        var fallbackDurable = false
        launch.onFailure { cause ->
            val message = cause.message ?: cause.javaClass.simpleName
            runCatching {
                MainaPostProcessingOutbox.shared(applicationContext).begin(
                    meetingId,
                    directory,
                    lastCaptureStartedAt,
                    System.currentTimeMillis(),
                    0L,
                    0L,
                    0,
                    0,
                    snapshot.routeRestartCount,
                    snapshot.captureGapMs,
                )
                MainaPostProcessingOutbox.shared(applicationContext).defer(
                    meetingId,
                    "Saved audio is waiting for local transcription: $message",
                )
                MainaPostProcessingRecoveryScheduler.enqueue(applicationContext, meetingId)
            }.onSuccess { fallbackDurable = true }
            recordNativeEvent(
                level = "warn",
                category = "native-post-processing",
                eventName = "post-processing-start-deferred",
                message = "Saved audio will resume transcription when Maina is foregrounded",
                payload = mapOf("meetingId" to meetingId, "error" to message),
            )
        }
        if (launch.isSuccess || fallbackDurable) {
            captureControlStore.clear()
            durableControl = null
        } else {
            postProcessingHandledMeetingId = null
        }
    }

    private fun handleAbortCompletion(snapshot: MainaNativeAudioCapture.Snapshot) {
        // Discard is terminal and never enqueues post-processing.
        postProcessingHandledMeetingId = snapshot.meetingId ?: lastCaptureMeetingId
        lastCaptureMeetingId = null
        lastCaptureDirectory = null
        lastCaptureStartedAt = 0L
        captureControlStore.clear()
        durableControl = null
    }

    private fun refreshForegroundUi() {
        if (!isRunning) return
        updateMediaState()
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification())
    }

    private fun buildNotification(): Notification {
        val remoteStatus = MainaHardwareTrigger.status(this)
        val accessibilityEnabled = remoteStatus["accessibilityEnabled"] as? Boolean ?: false
        val accessibilityConnected = remoteStatus["accessibilityConnected"] as? Boolean ?: false
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pendingIntent = launchIntent?.let {
            PendingIntent.getActivity(
                this,
                0,
                it.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        builder
            .setSmallIcon(applicationInfo.icon)
            .setContentTitle(
                when (captureState) {
                    "recording" -> "Maina is recording"
                    "paused" -> "Maina is paused"
                    "finalizing" -> "Maina is saving"
                    else -> "Maina is ready"
                },
            )
            .setContentText(
                when (captureState) {
                    "recording" -> "Audio recovery is active."
                    "paused" -> "Resume or stop and save this meeting."
                    "finalizing" -> "Finalising transcript and audio files."
                    else -> when {
                        !accessibilityEnabled -> "Enable clicker control in Accessibility for locked-screen use."
                        !accessibilityConnected -> "Re-open Maina and verify the clicker once before your meeting."
                        else -> "Remote control is armed until reboot or force-stop."
                    }
                },
            )
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setShowWhen(true)
        when (captureState) {
            "recording" -> {
                builder.addAction(notificationAction("Pause", MainaHardwareTrigger.ACTION_PAUSE, 11))
                builder.addAction(notificationAction("Stop & save", MainaHardwareTrigger.ACTION_STOP, 12))
            }
            "paused" -> {
                builder.addAction(notificationAction("Resume", MainaHardwareTrigger.ACTION_RESUME, 13))
                builder.addAction(notificationAction("Stop & save", MainaHardwareTrigger.ACTION_STOP, 12))
            }
            "idle" -> builder.addAction(notificationAction("Start", MainaHardwareTrigger.ACTION_START, 10))
        }
        return builder.build()
    }

    private fun notificationAction(label: String, action: String, requestCode: Int): Notification.Action {
        val intent = Intent(this, MainaRecordingService::class.java).setAction(action)
        val pending = PendingIntent.getService(
            this,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Action.Builder(0, label, pending).build()
    }

    private fun updateMediaState() {
        if (!::mediaSession.isInitialized) return
        val state = when (captureState) {
            "recording" -> PlaybackState.STATE_PLAYING
            "paused" -> PlaybackState.STATE_PAUSED
            "finalizing" -> PlaybackState.STATE_BUFFERING
            else -> PlaybackState.STATE_PAUSED
        }
        mediaSession.setPlaybackState(
            PlaybackState.Builder()
                .setActions(
                    PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or
                        PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_STOP or
                        PlaybackState.ACTION_SKIP_TO_NEXT,
                )
                .setState(state, PlaybackState.PLAYBACK_POSITION_UNKNOWN, if (state == PlaybackState.STATE_PLAYING) 1f else 0f)
                .build(),
        )
    }

    private fun vibrateTransition(previous: String, next: String) {
        val vibrator = getSystemService(Vibrator::class.java)
        val pattern = MainaCaptureHapticPolicy.waveform(previous, next) ?: return
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createWaveform(
                    pattern,
                    MainaCaptureHapticPolicy.amplitudes(pattern),
                    -1,
                ))
            } else {
                @Suppress("DEPRECATION")
                vibrator.vibrate(pattern, -1)
            }
        }
    }

    private fun reportDeviceChange(change: String, device: AudioDeviceInfo) {
        if (::nativeCapture.isInitialized && captureState == "recording") {
            enqueueNativeWork {
                nativeCapture.requestRouteRefresh(change, device)
                nativeCaptureStatus = nativeCaptureStatus + nativeCapture.snapshot().asMap() + mapOf(
                    "state" to nativeCaptureStatus["state"],
                    "operationId" to nativeCaptureStatus["operationId"],
                )
            }
        }
        MainaAudioRouteBridge.emit(this, change, device)
        recordNativeEvent(
            level = "warn",
            eventName = "external-audio-device-$change",
            message = "External audio input $change",
            payload = mapOf(
                "change" to change,
                "deviceId" to device.id,
                "deviceType" to device.type,
                "deviceName" to device.productName.toString(),
                "isSource" to device.isSource,
            ),
        )
    }

    private fun reportActiveRecording(config: AudioRecordingConfiguration) {
        val device = config.audioDevice
        recordNativeEvent(
            level = if (device == null) "warn" else "info",
            eventName = "active-recording-route",
            message = "Active recording route changed",
            payload = mapOf(
                "audioSessionId" to config.clientAudioSessionId,
                "audioSource" to config.clientAudioSource,
                "deviceId" to (device?.id ?: -1),
                "deviceType" to (device?.type ?: -1),
                "deviceName" to (device?.productName?.toString() ?: "unknown"),
                "clientSampleRate" to config.clientFormat.sampleRate,
                "clientChannels" to config.clientFormat.channelCount,
                "actualSampleRate" to config.format.sampleRate,
                "actualChannels" to config.format.channelCount,
                "silenced" to if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) config.isClientSilenced else false,
            ),
        )
    }

    private fun updateCommunicationWatch() {
        requireMainReducer()
        heartbeatHandler.removeCallbacks(communicationWatchRunnable)
        if (isRunning && MainaCallInterruptionPolicy.shouldWatchCommunication(controlState)) {
            heartbeatHandler.postDelayed(communicationWatchRunnable, COMMUNICATION_WATCH_INTERVAL_MS)
        }
    }

    private fun refreshedClientSilenced(): Boolean {
        val observed = nativeCapture.ownClientSilenced()
        return MainaCallInterruptionPolicy.refreshedClientSilenced(clientSilenced, observed).also {
            clientSilenced = it
        }
    }

    private fun observedCommunicationActive(): Boolean {
        return MainaCallInterruptionPolicy.communicationActive(
            audioMode = audioManager.mode,
            clientSilenced = refreshedClientSilenced(),
        )
    }

    private fun reconcileCommunicationInterruption() {
        if (!::nativeCapture.isInitialized ||
            !MainaCaptureLifecyclePolicy.acceptsNativeWork(acceptingNativeWork, destroyed)
        ) return
        val nextCommunicationActive = observedCommunicationActive()
        val previousState = controlState
        when (val decision = MainaCallInterruptionPolicy.onCommunicationChanged(previousState, nextCommunicationActive)) {
            is MainaCaptureControlDecision.Pause -> {
                cancelCommunicationRetryTimer()
                communicationResumeStartedAtMs = 0L
                communicationResumeAttempts = 0
                var operation: MainaCaptureOperationToken? = null
                val persistenceFailure = MainaCaptureSafetySequencer.latchApplyPersistThenQueue(
                        latch = nativeCapture::latchSystemDrainNow,
                    apply = {
                        applyControlState(decision.state)
                        operation = issueCaptureOperation(
                            kind = MainaCaptureOperationKind.PAUSE,
                            owner = MainaCapturePauseOwner.SYSTEM,
                            expectedPhase = MainaCaptureControlPhase.PAUSE_PENDING,
                        )
                    },
                    persist = { persistControlStateOrThrow(decision.state, "system-pause-pending") },
                    queue = {
                        operation?.let {
                            dispatchNativePause(
                                operation = it,
                                pendingState = "pausing",
                                completedEvent = "system-paused",
                                failedEvent = "system-pause-checkpoint-timeout",
                            )
                        }
                    },
                )
                persistenceFailure?.let { recordControlPersistenceFailure("system-pause-pending", it) }
                runCatching {
                    recordNativeEvent(
                        level = "info",
                        category = "native-capture",
                        eventName = "native-capture-auto-paused-for-communication",
                        message = "Capture paused while another communication session owns the microphone",
                        payload = mapOf("audioMode" to audioManager.mode, "clientSilenced" to clientSilenced),
                    )
                }
            }
            is MainaCaptureControlDecision.Resume -> {
                if (updateControlState(decision.state, "system-resume-pending")) {
                    scheduleCommunicationResume()
                } else {
                    failClosedResumeDurability(MainaCapturePauseOwner.SYSTEM)
                }
            }
            is MainaCaptureControlDecision.StateOnly -> {
                if (decision.state != previousState) {
                    val resumeWasInterrupted = nextCommunicationActive &&
                        previousState.phase == MainaCaptureControlPhase.RESUME_PENDING
                    if (resumeWasInterrupted) nativeCapture.revokeSystemResumeForCommunicationReentryNow()
                    updateControlState(decision.state, "communication-observed")
                    cancelCommunicationRetryTimer()
                    if (nextCommunicationActive) {
                        communicationResumeStartedAtMs = 0L
                        communicationResumeAttempts = 0
                        if (resumeWasInterrupted) {
                            // A communication session reacquired the microphone
                            // while resume was preparing a read-disabled recorder.
                            invalidateActiveOperation()
                            queueNativePauseWithoutReducer("communication-resume-cleanup-timeout")
                        }
                    }
                }
            }
            is MainaCaptureControlDecision.Denied -> Unit
        }
    }

    private fun scheduleCommunicationResume() {
        if (communicationResumeScheduled || controlState.communicationActive) return
        if (controlState.phase == MainaCaptureControlPhase.PAUSED &&
            controlState.pauseOwner == MainaCapturePauseOwner.SYSTEM
        ) {
            val decision = MainaCallInterruptionPolicy.onCommunicationChanged(controlState, active = false)
            if (decision is MainaCaptureControlDecision.Resume) {
                if (!updateControlState(decision.state, "system-resume-retry-pending")) {
                    failClosedResumeDurability(MainaCapturePauseOwner.SYSTEM)
                    return
                }
            }
        }
        if (controlState.phase != MainaCaptureControlPhase.RESUME_PENDING ||
            controlState.pauseOwner != MainaCapturePauseOwner.SYSTEM
        ) return
        val now = SystemClock.elapsedRealtime()
        if (communicationResumeStartedAtMs == 0L) communicationResumeStartedAtMs = now
        if (now - communicationResumeStartedAtMs >= MainaCallInterruptionPolicy.RESUME_RETRY_BUDGET_MS) {
            cancelCommunicationRetryTimer()
            updateControlState(
                MainaCallInterruptionPolicy.resumeFailed(controlState),
                "system-resume-exhausted",
            )
            nativeCaptureStatus = nativeCapture.snapshot().asMap() + mapOf(
                "state" to "paused",
                "pauseReason" to "communication",
                "lastError" to "Recording remains paused because the microphone did not become available.",
            )
            recordNativeEvent(
                level = "warn",
                category = "native-capture",
                eventName = "native-capture-auto-resume-exhausted",
                message = "Capture remains paused after bounded communication recovery",
                payload = mapOf("attempts" to communicationResumeAttempts),
            )
            refreshForegroundUi()
            // The durable chunks are complete and safe. Finish this meeting as
            // partial instead of leaving a pocket recording silently stuck.
            postMainOutcome {
                onStartCommand(
                    Intent(this, MainaRecordingService::class.java).setAction(ACTION_STOP_NATIVE_CAPTURE),
                    0,
                    0,
                )
            }
            return
        }
        communicationResumeScheduled = true
        val expectedGeneration = controlState.generation
        val delayMs = MainaCallInterruptionPolicy.resumeRetryDelayMs(communicationResumeAttempts)
        heartbeatHandler.postDelayed({
            communicationResumeScheduled = false
            if (!acceptingNativeWork || destroyed) return@postDelayed
            if (expectedGeneration != controlState.generation ||
                controlState.communicationActive ||
                controlState.phase != MainaCaptureControlPhase.RESUME_PENDING ||
                controlState.pauseOwner != MainaCapturePauseOwner.SYSTEM
            ) return@postDelayed
            communicationResumeAttempts += 1
            val operation = issueCaptureOperation(
                kind = MainaCaptureOperationKind.RESUME,
                owner = MainaCapturePauseOwner.SYSTEM,
                expectedPhase = MainaCaptureControlPhase.RESUME_PENDING,
            )
            dispatchPreparedCapture(
                operation = operation,
                pendingState = "resuming",
                committedEvent = "system-resumed",
                publicationEvent = "system-resume-published",
                failureEvent = "system-resume-attempt-failed",
            ) {
                nativeCapture.resumeAfterCommunication(
                    operation.expectedPrivacyLatchGeneration
                        ?: error("Resume privacy authority is unavailable"),
                )
            }
        }, COMMUNICATION_RESUME_TOKEN, SystemClock.uptimeMillis() + delayMs)
    }

    private fun cancelCommunicationRetryTimer() {
        communicationResumeScheduled = false
        communicationResumeStartedAtMs = 0L
        communicationResumeAttempts = 0
        heartbeatHandler.removeCallbacksAndMessages(COMMUNICATION_RESUME_TOKEN)
    }

    private fun applyControlState(nextState: MainaCaptureControlState) {
        requireMainReducer()
        controlState = nextState
        updateCommunicationWatch()
    }

    private fun persistControlStateOrThrow(nextState: MainaCaptureControlState, event: String) {
        requireMainReducer()
        val currentDurable = durableControl
        val snapshot = nativeCapture.snapshot()
        if (currentDurable != null) {
            check(captureControlStore.update(currentDurable, nextState, nativeCapture.snapshot())) {
                "Could not persist native capture control state"
            }
            durableControl = if (nextState.phase == MainaCaptureControlPhase.TERMINAL) {
                null
            } else {
                captureControlStore.read()
                    ?: error("Persisted capture control state could not be re-read")
            }
        }
        if (::nativeCapture.isInitialized) {
            nativeCapture.persistControlTransition(
                event,
                mapOf(
                    "meetingId" to lastCaptureMeetingId,
                    "phase" to nextState.phase.name.lowercase(),
                    "pauseOwner" to nextState.pauseOwner.name.lowercase(),
                    "generation" to nextState.generation,
                    "communicationActive" to nextState.communicationActive,
                    "chunkIndex" to snapshot.chunkIndex,
                ),
            )
        }
    }

    private fun recordControlPersistenceFailure(event: String, cause: Throwable) {
        val message = cause.message ?: cause.javaClass.simpleName
        nativeCaptureStatus = nativeCaptureStatus + mapOf(
            "lastError" to "Capture control durability failed: $message",
        )
        runCatching {
            recordNativeEvent(
                level = "error",
                category = "native-capture",
                eventName = "$event-durability-failed",
                message = "Capture control transition could not be made durable",
                payload = mapOf("error" to message),
            )
        }
    }

    private fun updateControlState(nextState: MainaCaptureControlState, event: String): Boolean {
        applyControlState(nextState)
        return runCatching { persistControlStateOrThrow(nextState, event) }
            .onFailure { recordControlPersistenceFailure(event, it) }
            .isSuccess
    }

    private fun invalidateCaptureControl(event: String) {
        cancelCommunicationRetryTimer()
        invalidateActiveOperation()
        updateControlState(MainaCallInterruptionPolicy.terminal(controlState), event)
    }

    private fun restoreDurableCaptureControl() {
        val restored = captureControlStore.read() ?: return
        if (!MainaCallInterruptionPolicy.shouldRestoreAfterProcessDeath(restored.reducerState())) return
        val processGapMs = (System.currentTimeMillis() - restored.updatedAtEpochMs).coerceAtLeast(0L)
        val snapshot = nativeCapture.restorePausedSession(
            MainaNativeAudioCapture.Options(
                meetingId = restored.meetingId,
                directory = restored.directory,
                sourceMode = restored.sourceMode,
                chunkDurationMs = restored.chunkDurationMs,
            ),
            restored.captureGapMs + processGapMs,
        )
        // The paused native shell exposes the exact resolved source without
        // enabling reads, so silencing refresh is source-specific even here.
        val communicationActive = observedCommunicationActive()
        val restoredState = MainaCallInterruptionPolicy.restoreAfterProcessDeath(
            restored.reducerState(),
            communicationActive,
        )
        lastCaptureMeetingId = restored.meetingId
        lastCaptureDirectory = restored.directory
        lastCaptureStartedAt = restored.meetingStartedAt
        postProcessingHandledMeetingId = null
        durableControl = restored
        controlState = restoredState
        val restorationPersisted = runCatching {
            check(captureControlStore.update(restored, restoredState, snapshot)) {
                "Could not persist fail-closed capture restoration"
            }
            durableControl = captureControlStore.read()
                ?: error("Persisted fail-closed restoration could not be re-read")
        }.onFailure {
            recordControlPersistenceFailure("process-restored-fail-closed", it)
        }.isSuccess
        captureState = "paused"
        nativeCaptureStatus = snapshot.asMap() + mapOf(
            "state" to "paused",
            "pauseReason" to restoredState.pauseOwner.name.lowercase(),
            "restoredAfterProcessDeath" to true,
        )
        recordNativeEvent(
            level = "warn",
            category = "native-capture",
            eventName = "native-capture-restored-fail-closed",
            message = "Native capture state was restored after service process recreation",
            payload = mapOf(
                "meetingId" to restored.meetingId,
                "phase" to restoredState.phase.name.lowercase(),
                "pauseOwner" to restoredState.pauseOwner.name.lowercase(),
                "generation" to restoredState.generation,
            ),
        )
        if (restorationPersisted && restoredState.pauseOwner == MainaCapturePauseOwner.SYSTEM && !communicationActive) {
            val decision = MainaCallInterruptionPolicy.onCommunicationChanged(restoredState, active = false)
            if (decision is MainaCaptureControlDecision.Resume) {
                if (updateControlState(decision.state, "process-restored-resume-pending")) {
                    scheduleCommunicationResume()
                } else {
                    failClosedResumeDurability(MainaCapturePauseOwner.SYSTEM)
                }
            }
        }
    }

    private fun emitServiceHeartbeat() {
        if (::nativeCapture.isInitialized && captureState != "idle") {
            nativeCaptureStatus = nativeCaptureStatus + nativeCapture.snapshot().asMap() + mapOf(
                "state" to nativeCaptureStatus["state"],
                "operationId" to nativeCaptureStatus["operationId"],
            )
        }
        val runtime = Runtime.getRuntime()
        val memory = Debug.MemoryInfo().also { Debug.getMemoryInfo(it) }
        recordNativeEvent(
            level = "info",
            category = "native-service",
            eventName = "recording-service-heartbeat",
            message = "Recording service heartbeat",
            payload = mapOf(
                "captureState" to captureState,
                "serviceUptimeMs" to (SystemClock.elapsedRealtime() - serviceStartedAtMs),
                "knownExternalInputs" to knownExternalInputIds.size,
                "hasActiveRecordingRoute" to !lastRecordingSignature.isNullOrBlank(),
                "heapUsedBytes" to (runtime.totalMemory() - runtime.freeMemory()),
                "heapMaxBytes" to runtime.maxMemory(),
                "nativePssKb" to memory.totalPss,
                "nativePrivateDirtyKb" to memory.totalPrivateDirty,
                "freeStorageBytes" to filesDir.usableSpace,
            ),
        )
    }

    private fun recordNativeEvent(
        level: String,
        category: String = "native-audio",
        eventName: String,
        message: String,
        payload: Map<String, Any?>,
    ) {
        val store = DiagnosticsStore.shared(this)
        if (!store.config().enabled) return
        store.enqueueEvents(
                listOf(
                    mapOf(
                        "eventId" to UUID.randomUUID().toString(),
                        "occurredAt" to java.time.Instant.now().toString(),
                        "elapsedMs" to SystemClock.elapsedRealtime(),
                        "sequence" to 0L,
                        "level" to level,
                        "category" to category,
                        "eventName" to eventName,
                        "message" to message,
                        "payload" to payload,
                    ),
                ),
            )
        DiagnosticsScheduler.enqueueEvents(this, urgent = level == "error" || level == "warn")
    }
}
