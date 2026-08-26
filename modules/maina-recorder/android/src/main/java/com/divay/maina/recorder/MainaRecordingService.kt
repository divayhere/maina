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
    private lateinit var nativeCapture: MainaNativeAudioCapture
    @Volatile private var lastCaptureMeetingId: String? = null
    @Volatile private var lastCaptureDirectory: String? = null
    @Volatile private var lastCaptureStartedAt: Long = 0L
    @Volatile private var postProcessingHandledMeetingId: String? = null
    private val serviceStartedAtMs = SystemClock.elapsedRealtime()
    private val heartbeatRunnable = object : Runnable {
        override fun run() {
            if (!isRunning) return
            if (captureState != "idle") emitServiceHeartbeat()
            heartbeatHandler.postDelayed(this, 60_000)
        }
    }

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
                if (eventName == "native-capture-route-recovery-exhausted") {
                    // The capture thread has already finalized the last WAV chunk.
                    // Queue the normal stop path on the service executor so it starts
                    // post-processing exactly once; never leave a silent recorder
                    // shown as live just because a physical input disappeared.
                    nativeCaptureStatus = payload + mapOf("state" to "error")
                    heartbeatHandler.post {
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
                nativeCaptureStatus = payload + mapOf(
                    "operationId" to nativeCaptureStatus["operationId"],
                )
            },
        )
        nativeCaptureStatus = mapOf("state" to "idle")
        knownExternalInputIds += audioManager
            .getDevices(AudioManager.GET_DEVICES_INPUTS)
            .filter(MainaAudioRouteBridge::isExternalMicrophone)
            .map(AudioDeviceInfo::getId)
        audioManager.registerAudioRecordingCallback(recordingCallback, Handler(Looper.getMainLooper()))
        audioManager.registerAudioDeviceCallback(deviceCallback, Handler(Looper.getMainLooper()))
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
                val operationId = captureOperationSequence.incrementAndGet().also { latestCaptureOperation = it }
                lastCaptureMeetingId = meetingId
                lastCaptureDirectory = directory
                lastCaptureStartedAt = meetingStartedAt
                postProcessingHandledMeetingId = null
                nativeCaptureStatus = mapOf(
                    "state" to "starting",
                    "meetingId" to meetingId,
                    "sourceMode" to sourceMode,
                    "operationId" to operationId,
                )
                captureExecutor.execute {
                    runCatching {
                        nativeCapture.start(
                        MainaNativeAudioCapture.Options(
                            meetingId = meetingId,
                            directory = directory,
                            sourceMode = sourceMode,
                            chunkDurationMs = chunkDurationMs,
                        ),
                        )
                    }.onSuccess { snapshot ->
                        if (latestCaptureOperation == operationId) {
                            nativeCaptureStatus = snapshot.asMap() + mapOf("operationId" to operationId)
                            heartbeatHandler.post {
                                if (latestCaptureOperation == operationId) {
                                    setCaptureState("recording")
                                    refreshForegroundUi()
                                }
                            }
                        }
                    }.onFailure { cause ->
                        val message = cause.message ?: cause.javaClass.simpleName
                        if (latestCaptureOperation == operationId) {
                            nativeCaptureStatus = mapOf(
                                "state" to "error",
                                "meetingId" to meetingId,
                                "lastError" to message,
                                "operationId" to operationId,
                            )
                        }
                        recordNativeEvent(
                            level = "error",
                            category = "native-capture",
                            eventName = "native-capture-start-failed",
                            message = "Native capture could not start",
                            payload = mapOf("error" to message, "operationId" to operationId),
                        )
                        heartbeatHandler.post {
                            if (latestCaptureOperation == operationId) {
                                setCaptureState("idle")
                                refreshForegroundUi()
                            }
                        }
                    }
                }
            }
            ACTION_PAUSE_NATIVE_CAPTURE -> {
                submitCaptureCommand(
                    pendingState = "pausing",
                    successfulCaptureState = "paused",
                    operation = { nativeCapture.pause() },
                )
            }
            ACTION_RESUME_NATIVE_CAPTURE -> {
                submitCaptureCommand(
                    pendingState = "resuming",
                    successfulCaptureState = "recording",
                    operation = { nativeCapture.resume() },
                )
            }
            ACTION_STOP_NATIVE_CAPTURE -> {
                setCaptureState("finalizing")
                submitCaptureCommand(
                    pendingState = "finalizing",
                    successfulCaptureState = "idle",
                    operation = { nativeCapture.stop() },
                    onSuccess = { snapshot ->
                        val meetingId = snapshot.meetingId ?: lastCaptureMeetingId ?: return@submitCaptureCommand
                        val directory = lastCaptureDirectory ?: return@submitCaptureCommand
                        // Stop commands can arrive more than once (notification,
                        // clicker, JS cleanup). A meeting must enter native ASR
                        // only once or a late duplicate would erase and rebuild
                        // an already completed transcript.
                        if (postProcessingHandledMeetingId == meetingId) return@submitCaptureCommand
                        postProcessingHandledMeetingId = meetingId
                        val intent = Intent(this, MainaPostProcessingService::class.java).apply {
                            action = MainaPostProcessingService.ACTION_START
                            putExtra(MainaPostProcessingService.EXTRA_MEETING_ID, meetingId)
                            putExtra(MainaPostProcessingService.EXTRA_DIRECTORY, directory)
                            putExtra(MainaPostProcessingService.EXTRA_CAPTURE_ENDED_AT, System.currentTimeMillis())
                            putExtra(MainaPostProcessingService.EXTRA_MEETING_STARTED_AT, lastCaptureStartedAt)
                            putExtra(
                                MainaPostProcessingService.EXTRA_ROUTE_RESTART_COUNT,
                                snapshot.routeRestartCount,
                            )
                            putExtra(
                                MainaPostProcessingService.EXTRA_CAPTURE_GAP_MS,
                                snapshot.captureGapMs,
                            )
                        }
                        runCatching {
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                                startForegroundService(intent)
                            } else {
                                startService(intent)
                            }
                        }.onFailure { cause ->
                            val message = cause.message ?: cause.javaClass.simpleName
                            runCatching {
                                MainaPostProcessingOutbox.shared(applicationContext).begin(
                                    meetingId,
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
                            }
                            recordNativeEvent(
                                level = "warn",
                                category = "native-post-processing",
                                eventName = "post-processing-start-deferred",
                                message = "Saved audio will resume transcription when Maina is foregrounded",
                                payload = mapOf("meetingId" to meetingId, "error" to message),
                            )
                        }
                    },
                )
            }
            ACTION_ABORT_NATIVE_CAPTURE -> {
                setCaptureState("finalizing")
                submitCaptureCommand(
                    pendingState = "finalizing",
                    successfulCaptureState = "idle",
                    operation = { nativeCapture.stop() },
                    onSuccess = { snapshot ->
                        // Discard is intentionally terminal and must never
                        // enqueue ASR. Mark the meeting handled before React
                        // deletes its row/audio so unmount cleanup is idempotent.
                        postProcessingHandledMeetingId = snapshot.meetingId ?: lastCaptureMeetingId
                        lastCaptureMeetingId = null
                        lastCaptureDirectory = null
                        lastCaptureStartedAt = 0L
                    },
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
        updateMediaState()
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification)
        if (captureState != "idle") emitServiceHeartbeat()
        return START_STICKY
    }

    override fun onDestroy() {
        isRunning = false
        captureExecutor.execute {
            runCatching { nativeCaptureStatus = nativeCapture.stop().asMap() }
        }
        captureExecutor.shutdown()
        heartbeatHandler.removeCallbacks(heartbeatRunnable)
        runCatching { audioManager.unregisterAudioRecordingCallback(recordingCallback) }
        runCatching { audioManager.unregisterAudioDeviceCallback(deviceCallback) }
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

    private fun submitCaptureCommand(
        pendingState: String,
        successfulCaptureState: String,
        operation: () -> MainaNativeAudioCapture.Snapshot,
        onSuccess: (MainaNativeAudioCapture.Snapshot) -> Unit = {},
    ) {
        val operationId = captureOperationSequence.incrementAndGet().also { latestCaptureOperation = it }
        nativeCaptureStatus = nativeCapture.snapshot().asMap() + mapOf(
            "state" to pendingState,
            "operationId" to operationId,
        )
        captureExecutor.execute {
            runCatching(operation)
                .onSuccess { snapshot ->
                    if (latestCaptureOperation == operationId) {
                        nativeCaptureStatus = snapshot.asMap() + mapOf("operationId" to operationId)
                        heartbeatHandler.post {
                            if (latestCaptureOperation == operationId) {
                                setCaptureState(successfulCaptureState)
                                refreshForegroundUi()
                            }
                        }
                        runCatching { onSuccess(snapshot) }.onFailure { cause ->
                            recordNativeEvent(
                                level = "error",
                                category = "native-post-processing",
                                eventName = "capture-success-follow-up-failed",
                                message = "Capture completed but its follow-up action failed",
                                payload = mapOf(
                                    "successfulCaptureState" to successfulCaptureState,
                                    "error" to (cause.message ?: cause.javaClass.simpleName),
                                    "operationId" to operationId,
                                ),
                            )
                        }
                    }
                }
                .onFailure { cause ->
                    val message = cause.message ?: cause.javaClass.simpleName
                    if (latestCaptureOperation == operationId) {
                        nativeCaptureStatus = nativeCapture.snapshot().asMap() + mapOf(
                            "state" to "error",
                            "lastError" to message,
                            "operationId" to operationId,
                        )
                    }
                    recordNativeEvent(
                        level = "error",
                        category = "native-capture",
                        eventName = "native-capture-command-failed",
                        message = "Native capture command failed",
                        payload = mapOf(
                            "pendingState" to pendingState,
                            "error" to message,
                            "operationId" to operationId,
                        ),
                    )
                    heartbeatHandler.post {
                        if (latestCaptureOperation == operationId) {
                            setCaptureState(if (nativeCapture.snapshot().state == "idle") "idle" else captureState)
                            refreshForegroundUi()
                        }
                    }
                }
        }
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
            captureExecutor.execute {
                nativeCapture.requestRouteRefresh(change, device)
                nativeCaptureStatus = nativeCapture.snapshot().asMap() + mapOf(
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

    private fun emitServiceHeartbeat() {
        if (::nativeCapture.isInitialized && captureState != "idle") {
            nativeCaptureStatus = nativeCapture.snapshot().asMap() + mapOf(
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
