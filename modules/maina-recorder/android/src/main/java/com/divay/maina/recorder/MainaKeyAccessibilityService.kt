package com.divay.maina.recorder

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.ComponentName
import android.content.Context
import android.provider.Settings
import android.util.Log
import android.view.InputDevice
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent

/** Event-driven global key owner for the dedicated AB Shutter remote. */
class MainaKeyAccessibilityService : AccessibilityService() {
    companion object {
        @Volatile
        var isConnected: Boolean = false
            private set

        fun isEnabled(context: Context): Boolean {
            val expected = ComponentName(context, MainaKeyAccessibilityService::class.java).flattenToString()
            val enabled = Settings.Secure.getString(
                context.contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
            ).orEmpty()
            return enabled.split(':').any { it.equals(expected, ignoreCase = true) }
        }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        serviceInfo = serviceInfo.apply {
            // Key filtering is independent of accessibility-event delivery.
            // Maina does not inspect windows, so subscribe to no UI events.
            eventTypes = 0
            flags = flags or AccessibilityServiceInfo.FLAG_REQUEST_FILTER_KEY_EVENTS
        }
        isConnected = true
        recordLifecycle("connected", "Maina remote accessibility service connected")
    }

    override fun onInterrupt() {
        recordLifecycle("interrupted", "Maina remote accessibility service interrupted")
    }

    override fun onDestroy() {
        isConnected = false
        recordLifecycle("destroyed", "Maina remote accessibility service destroyed")
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit

    override fun onKeyEvent(event: KeyEvent): Boolean {
        if (!MainaRemoteDeviceMatcher.isSupportedKey(event.keyCode)) return false
        val device = InputDevice.getDevice(event.deviceId)
        if (!MainaRemoteDeviceMatcher.isTrusted(this, device)) return false

        // Consume both halves of the matched remote press so Android never
        // applies its underlying volume/camera action.
        if (event.action != KeyEvent.ACTION_UP || event.repeatCount != 0) return true
        val command = MainaHardwareTrigger.commandForKey(event.keyCode) ?: return false
        MainaHardwareTrigger.emit(
            context = this,
            command = command,
            source = "accessibility-hid",
            keyCode = event.keyCode,
            deviceId = event.deviceId,
            deviceName = device?.name ?: "AB Shutter",
        )
        return true
    }

    private fun recordLifecycle(eventName: String, message: String) {
        // This service intentionally lives in a tiny secondary process. Do not
        // initialise React Native, WorkManager, or the diagnostics database here:
        // doing so would keep the full application awake while the phone is locked.
        getSharedPreferences("maina-accessibility-status", Context.MODE_PRIVATE)
            .edit()
            .putString("last_lifecycle", eventName)
            .putLong("last_lifecycle_at", System.currentTimeMillis())
            .apply()
        Log.i("MainaRemote", "$eventName: $message")
    }
}
