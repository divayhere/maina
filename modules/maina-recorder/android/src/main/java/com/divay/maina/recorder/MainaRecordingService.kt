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
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import java.util.UUID

/**
 * Keeps Maina's process in Android's microphone foreground state while the
 * speech module owns AudioRecord. The persistent notification is intentional:
 * Android requires it for trustworthy screen-off microphone capture.
 */
class MainaRecordingService : Service() {
    private lateinit var audioManager: AudioManager
    private var lastRecordingSignature: String? = null
    private val knownExternalInputIds = mutableSetOf<Int>()

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

        @Volatile
        var isRunning: Boolean = false
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
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
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
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        isRunning = false
        runCatching { audioManager.unregisterAudioRecordingCallback(recordingCallback) }
        runCatching { audioManager.unregisterAudioDeviceCallback(deviceCallback) }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Meeting recording",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Shown while Maina records a meeting"
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
        return builder
            .setSmallIcon(applicationInfo.icon)
            .setContentTitle("Maina is recording")
            .setContentText("Tap to return. Recording recovery remains active.")
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setShowWhen(true)
            .build()
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

    private fun recordNativeEvent(
        level: String,
        eventName: String,
        message: String,
        payload: Map<String, Any?>,
    ) {
        val store = DiagnosticsStore(this)
        try {
            if (!store.config().enabled) return
            store.enqueueEvents(
                listOf(
                    mapOf(
                        "eventId" to UUID.randomUUID().toString(),
                        "occurredAt" to java.time.Instant.now().toString(),
                        "elapsedMs" to SystemClock.elapsedRealtime(),
                        "sequence" to 0L,
                        "level" to level,
                        "category" to "native-audio",
                        "eventName" to eventName,
                        "message" to message,
                        "payload" to payload,
                    ),
                ),
            )
            DiagnosticsScheduler.enqueue(this)
        } finally {
            store.close()
        }
    }
}
