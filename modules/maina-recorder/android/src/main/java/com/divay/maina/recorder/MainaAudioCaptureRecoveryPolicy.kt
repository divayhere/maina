package com.divay.maina.recorder

import android.media.AudioDeviceInfo

/** Pure policy seam for route-recovery timing and external-input preference. */
internal object MainaAudioCaptureRecoveryPolicy {
    private val retryDelaysMs = longArrayOf(100L, 250L, 500L, 1_000L)

    /**
     * A removed USB/Bluetooth device can stay visible briefly while Android tears
     * down its route. Prefer it only for the first two attempts. The next attempt
     * deliberately clears the preference so AudioRecord uses Android's current
     * default (normally the built-in microphone). This keeps a physical route
     * change from becoming an unbounded "retry the dead receiver" loop.
     */
    const val EXTERNAL_PREFERRED_ATTEMPTS = 2

    /**
     * This is a capture-continuity budget, not a transcription timeout. A short
     * physical input change may cost a little audio; keeping a meeting silently
     * stuck for tens of seconds is worse. The bound leaves room for the initial
     * route teardown plus a default-mic fallback.
     */
    const val MAX_ROUTE_RECOVERY_MS = 2_800L

    fun delayMs(attemptIndex: Int): Long = retryDelaysMs[attemptIndex.coerceIn(0, retryDelaysMs.lastIndex)]

    fun shouldPreferExternalInput(attempt: Int): Boolean = attempt < EXTERNAL_PREFERRED_ATTEMPTS

    fun isWithinRecoveryBudget(elapsedMs: Long): Boolean = elapsedMs < MAX_ROUTE_RECOVERY_MS

    fun shouldRecover(readResult: Int, routeRefreshRequested: Boolean): Boolean =
        routeRefreshRequested || readResult < 0

    fun externalInputPriority(deviceType: Int): Int = when (deviceType) {
        AudioDeviceInfo.TYPE_USB_HEADSET -> 400
        AudioDeviceInfo.TYPE_USB_DEVICE -> 350
        AudioDeviceInfo.TYPE_USB_ACCESSORY -> 340
        AudioDeviceInfo.TYPE_WIRED_HEADSET -> 300
        AudioDeviceInfo.TYPE_BLE_HEADSET -> 220
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> 200
        else -> 0
    }
}
