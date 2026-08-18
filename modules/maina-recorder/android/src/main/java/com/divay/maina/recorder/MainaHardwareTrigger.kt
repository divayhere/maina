package com.divay.maina.recorder

import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.view.InputDevice
import android.view.KeyEvent

/** Activity-level bridge for OS-paired HID shutter remotes. */
object MainaHardwareTrigger {
    const val ACTION_TRIGGER = "com.divay.maina.recorder.HARDWARE_TRIGGER"
    const val EXTRA_KEY_CODE = "keyCode"
    const val EXTRA_DEVICE_ID = "deviceId"
    const val EXTRA_OCCURRED_AT = "occurredAt"

    private const val DEBOUNCE_MS = 450L
    private var lastTriggerAt = 0L

    private val supportedKeys = setOf(
        KeyEvent.KEYCODE_VOLUME_UP,
        KeyEvent.KEYCODE_VOLUME_DOWN,
        KeyEvent.KEYCODE_CAMERA,
        KeyEvent.KEYCODE_ENTER,
        KeyEvent.KEYCODE_DPAD_CENTER,
        KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
        KeyEvent.KEYCODE_HEADSETHOOK,
    )

    @JvmStatic
    fun handle(context: Context, event: KeyEvent): Boolean {
        if (event.keyCode !in supportedKeys) return false
        val device = InputDevice.getDevice(event.deviceId)
        val externalHid = event.deviceId > 0 && device != null && !device.isVirtual &&
            device.sources and (InputDevice.SOURCE_KEYBOARD or InputDevice.SOURCE_DPAD) != 0
        if (!externalHid) return false
        // Consume DOWN as well so a shutter click does not change media volume.
        if (event.action != KeyEvent.ACTION_UP || event.repeatCount != 0) return true
        val now = SystemClock.elapsedRealtime()
        if (now - lastTriggerAt < DEBOUNCE_MS) return true
        lastTriggerAt = now
        context.sendBroadcast(
            Intent(ACTION_TRIGGER)
                .setPackage(context.packageName)
                .putExtra(EXTRA_KEY_CODE, event.keyCode)
                .putExtra(EXTRA_DEVICE_ID, event.deviceId)
                .putExtra(EXTRA_OCCURRED_AT, System.currentTimeMillis()),
        )
        return true
    }
}
