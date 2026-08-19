package com.divay.maina.recorder

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.hardware.input.InputManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.KeyEvent
import java.util.UUID

/** Normalises every hardware source into Maina's small command protocol. */
object MainaHardwareTrigger {
    const val ACTION_TRIGGER = "com.divay.maina.recorder.HARDWARE_TRIGGER"
    const val ACTION_START = "com.divay.maina.action.START"
    const val ACTION_TOGGLE = "com.divay.maina.action.TOGGLE"
    const val ACTION_PAUSE = "com.divay.maina.action.PAUSE"
    const val ACTION_RESUME = "com.divay.maina.action.RESUME"
    const val ACTION_STOP = "com.divay.maina.action.STOP"

    const val EXTRA_KEY_CODE = "keyCode"
    const val EXTRA_DEVICE_ID = "deviceId"
    const val EXTRA_DEVICE_NAME = "deviceName"
    const val EXTRA_OCCURRED_AT = "occurredAt"
    const val EXTRA_COMMAND = "command"
    const val EXTRA_COMMAND_ID = "commandId"
    const val EXTRA_SOURCE = "source"

    private const val DOUBLE_PRESS_MS = 420L
    private val mainHandler = Handler(Looper.getMainLooper())
    private var pendingPrimary: Runnable? = null
    private var pendingDeviceId = -1
    private var pendingAt = 0L

    internal val toggleKeys = setOf(
        KeyEvent.KEYCODE_VOLUME_UP,
        KeyEvent.KEYCODE_CAMERA,
        KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
        KeyEvent.KEYCODE_HEADSETHOOK,
        KeyEvent.KEYCODE_MEDIA_PLAY,
        KeyEvent.KEYCODE_MEDIA_PAUSE,
    )
    internal val stopKeys = setOf(
        KeyEvent.KEYCODE_VOLUME_DOWN,
        KeyEvent.KEYCODE_ENTER,
        KeyEvent.KEYCODE_DPAD_CENTER,
        KeyEvent.KEYCODE_MEDIA_STOP,
        KeyEvent.KEYCODE_MEDIA_NEXT,
    )
    internal val supportedKeys = toggleKeys + stopKeys
    private var lastEmissionAt = 0L
    private var lastEmissionKey = Int.MIN_VALUE
    private var lastEmissionCommand = ""

    /** Activity-level support for generic Bluetooth camera shutter remotes. */
    @JvmStatic
    fun handle(context: Context, event: KeyEvent): Boolean {
        if (event.keyCode !in supportedKeys) return false
        val device = InputDevice.getDevice(event.deviceId)
        if (!MainaRemoteDeviceMatcher.isTrusted(context, device)) return false
        if (event.action != KeyEvent.ACTION_UP || event.repeatCount != 0) return true
        commandForKey(event.keyCode)?.let {
            emit(context, it, "activity-hid", event.keyCode, event.deviceId, device?.name ?: "AB Shutter")
        }
        return true
    }

    /** Single primary press toggles; a deliberate double press stops/saves. */
    fun handlePrimaryPress(
        context: Context,
        source: String,
        keyCode: Int,
        deviceId: Int,
        deviceName: String,
    ) {
        val now = SystemClock.elapsedRealtime()
        val doublePress = pendingPrimary != null && pendingDeviceId == deviceId && now - pendingAt <= DOUBLE_PRESS_MS
        if (doublePress) {
            cancelPendingPrimary()
            emit(context, "stop", "$source-double", keyCode, deviceId, deviceName)
            return
        }
        cancelPendingPrimary()
        pendingDeviceId = deviceId
        pendingAt = now
        pendingPrimary = Runnable {
            pendingPrimary = null
            emit(context, "toggle", source, keyCode, deviceId, deviceName)
        }.also { mainHandler.postDelayed(it, DOUBLE_PRESS_MS) }
    }

    @Synchronized
    fun emit(
        context: Context,
        command: String,
        source: String,
        keyCode: Int = -1,
        deviceId: Int = -1,
        deviceName: String = "unknown",
    ): String? {
        val elapsed = SystemClock.elapsedRealtime()
        if (command == lastEmissionCommand && keyCode == lastEmissionKey && elapsed - lastEmissionAt < 300L) {
            return null
        }
        lastEmissionAt = elapsed
        lastEmissionKey = keyCode
        lastEmissionCommand = command
        val occurredAt = System.currentTimeMillis()
        val commandId = UUID.randomUUID().toString()
        if (context !is MainaKeyAccessibilityService) {
            recordReceivedCommand(context, commandId, command, source, deviceName, keyCode, occurredAt)
        }
        context.sendBroadcast(
            Intent(ACTION_TRIGGER)
                .setPackage(context.packageName)
                .putExtra(EXTRA_COMMAND, command)
                .putExtra(EXTRA_COMMAND_ID, commandId)
                .putExtra(EXTRA_SOURCE, source)
                .putExtra(EXTRA_KEY_CODE, keyCode)
                .putExtra(EXTRA_DEVICE_ID, deviceId)
                .putExtra(EXTRA_DEVICE_NAME, deviceName)
                .putExtra(EXTRA_OCCURRED_AT, occurredAt),
        )
        recordTriggerEvent(
            context,
            "dispatched",
            "Hardware command dispatched",
            mapOf(
                "commandId" to commandId,
                "command" to command,
                "source" to source,
                "keyCode" to keyCode,
                "deviceId" to deviceId,
                "deviceName" to deviceName,
            ),
        )
        return commandId
    }

    /** Mirrors a remote-process command into main-process status storage. */
    fun noteReceived(context: Context, intent: Intent) {
        recordReceivedCommand(
            context = context,
            commandId = intent.getStringExtra(EXTRA_COMMAND_ID) ?: "",
            command = intent.getStringExtra(EXTRA_COMMAND) ?: "toggle",
            source = intent.getStringExtra(EXTRA_SOURCE) ?: "unknown",
            deviceName = intent.getStringExtra(EXTRA_DEVICE_NAME) ?: "unknown",
            keyCode = intent.getIntExtra(EXTRA_KEY_CODE, -1),
            occurredAt = intent.getLongExtra(EXTRA_OCCURRED_AT, System.currentTimeMillis()),
        )
    }

    fun commandForKey(keyCode: Int): String? = when (keyCode) {
        in stopKeys -> "stop"
        in toggleKeys -> "toggle"
        else -> null
    }

    fun acknowledge(context: Context, commandId: String, action: String, accepted: Boolean) {
        if (commandId.isBlank()) return
        val now = System.currentTimeMillis()
        statusPrefs(context).edit()
            .putString("last_ack_command_id", commandId)
            .putString("last_ack_action", action)
            .putBoolean("last_ack_accepted", accepted)
            .putLong("last_ack_at", now)
            .apply()
        recordTriggerEvent(
            context,
            "acknowledged",
            "Hardware command acknowledged",
            mapOf("commandId" to commandId, "action" to action, "accepted" to accepted),
        )
    }

    fun commandForAction(action: String?): String? = when (action) {
        ACTION_START -> "start"
        ACTION_TOGGLE -> "toggle"
        ACTION_PAUSE -> "pause"
        ACTION_RESUME -> "resume"
        ACTION_STOP -> "stop"
        else -> null
    }

    fun status(context: Context): Map<String, Any> {
        val prefs = statusPrefs(context)
        val inputDevices = context.getSystemService(InputManager::class.java).inputDeviceIds
            .toList()
            .mapNotNull { InputDevice.getDevice(it) }
            .filter { !it.isVirtual && it.isExternal && it.sources and (InputDevice.SOURCE_KEYBOARD or InputDevice.SOURCE_DPAD) != 0 }
            .map { "${it.name} (#${it.id})" }
            .distinct()
        return mapOf(
            "armed" to MainaRecordingService.isRunning,
            "captureState" to MainaRecordingService.captureState,
            "accessibilityEnabled" to MainaKeyAccessibilityService.isEnabled(context),
            // The accessibility listener is intentionally hosted in another
            // process, so its in-memory connection flag isn't visible here.
            // Android's enabled-services setting is the durable source of truth.
            "accessibilityConnected" to MainaKeyAccessibilityService.isEnabled(context),
            "notificationsEnabled" to context.getSystemService(NotificationManager::class.java).areNotificationsEnabled(),
            "inputDevices" to inputDevices,
            "lastCommand" to (prefs.getString("last_command", "never") ?: "never"),
            "lastCommandId" to (prefs.getString("last_command_id", "") ?: ""),
            "lastSource" to (prefs.getString("last_source", "none") ?: "none"),
            "lastDeviceName" to (prefs.getString("last_device_name", "none") ?: "none"),
            "lastKeyCode" to prefs.getInt("last_key_code", -1),
            "lastCommandAt" to prefs.getLong("last_command_at", 0L),
            "lastAckAction" to (prefs.getString("last_ack_action", "none") ?: "none"),
            "lastAckAccepted" to prefs.getBoolean("last_ack_accepted", false),
            "lastAckAt" to prefs.getLong("last_ack_at", 0L),
            "trustedRemoteName" to (
                MainaRemoteDeviceMatcher.rememberedName(context)
                    ?: prefs.getString("last_device_name", null)
                    ?: "AB Shutter3 (waiting for first press)"
                ),
        )
    }

    private fun recordReceivedCommand(
        context: Context,
        commandId: String,
        command: String,
        source: String,
        deviceName: String,
        keyCode: Int,
        occurredAt: Long,
    ) {
        statusPrefs(context).edit()
            .putString("last_command_id", commandId)
            .putString("last_command", command)
            .putString("last_source", source)
            .putString("last_device_name", deviceName)
            .putInt("last_key_code", keyCode)
            .putLong("last_command_at", occurredAt)
            .apply()
    }

    private fun recordTriggerEvent(
        context: Context,
        eventName: String,
        message: String,
        payload: Map<String, Any?>,
    ) {
        if (context is MainaKeyAccessibilityService) {
            // The receiving React Native process records the same command and
            // acknowledgement in Supabase. Keep the screen-off listener process
            // free of WorkManager/SQLite so it remains effectively dormant.
            Log.i("MainaRemote", "$eventName: $message $payload")
            return
        }
        val store = DiagnosticsStore.shared(context)
        if (!store.config().enabled) return
        store.enqueueEvents(
            listOf(
                mapOf(
                    "eventId" to UUID.randomUUID().toString(),
                    "occurredAt" to java.time.Instant.now().toString(),
                    "elapsedMs" to SystemClock.elapsedRealtime(),
                    "sequence" to 0L,
                    "level" to "info",
                    "category" to "native-trigger",
                    "eventName" to "command-$eventName",
                    "message" to message,
                    "payload" to payload,
                ),
            ),
        )
        DiagnosticsScheduler.enqueueEvents(context, urgent = eventName == "dispatched")
    }

    private fun cancelPendingPrimary() {
        pendingPrimary?.let(mainHandler::removeCallbacks)
        pendingPrimary = null
    }

    private fun statusPrefs(context: Context) =
        context.applicationContext.getSharedPreferences("maina-control-status", Context.MODE_PRIVATE)
}

/** Explicit compatibility endpoint for Key Mapper and similar local tools. */
class MainaCommandReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val command = MainaHardwareTrigger.commandForAction(intent?.action) ?: return
        MainaHardwareTrigger.emit(context, command, "external-intent")
    }
}
