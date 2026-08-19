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

/**
 * Keeps Maina's process in Android's microphone foreground state while the
 * speech module owns AudioRecord. The persistent notification is intentional:
 * Android requires it for trustworthy screen-off microphone capture.
 */
class MainaRecordingService : Service() {
    private lateinit var audioManager: AudioManager
    private lateinit var mediaSession: MediaSession
    private var lastRecordingSignature: String? = null
    private val knownExternalInputIds = mutableSetOf<Int>()
    private val heartbeatHandler = Handler(Looper.getMainLooper())
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
        const val EXTRA_CAPTURE_STATE = "captureState"

        @Volatile
        var isRunning: Boolean = false
            private set

        @Volatile
        var captureState: String = "idle"
            private set
    }

    override fun onCreate() {
        super.onCreate()
        createChannel()
        audioManager = getSystemService(AudioManager::class.java)
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

    private fun buildNotification(): Notification {
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
                    else -> "Remote control is armed until reboot or force-stop."
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
        val pattern = when {
            next == "paused" -> longArrayOf(0, 70, 80, 70)
            previous == "paused" && next == "recording" -> longArrayOf(0, 90)
            previous == "idle" && next == "recording" -> longArrayOf(0, 160)
            previous == "finalizing" && next == "idle" -> longArrayOf(0, 55, 65, 55, 65, 55)
            else -> return
        }
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createWaveform(pattern, -1))
            } else {
                @Suppress("DEPRECATION")
                vibrator.vibrate(pattern, -1)
            }
        }
    }

    private fun reportDeviceChange(change: String, device: AudioDeviceInfo) {
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
