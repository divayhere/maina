package com.divay.maina.recorder

import android.media.AudioDeviceInfo

/** Pure policy seam for route-recovery timing and external-input preference. */
internal object MainaAudioCaptureRecoveryPolicy {
    private val retryDelaysMs = longArrayOf(100L, 250L, 500L, 1_000L, 2_000L)

    fun delayMs(attemptIndex: Int): Long = retryDelaysMs[attemptIndex.coerceIn(0, retryDelaysMs.lastIndex)]

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
