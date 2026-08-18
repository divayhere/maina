package com.divay.maina.recorder

import android.content.Context
import android.content.Intent
import android.media.AudioDeviceInfo

object MainaAudioRouteBridge {
    const val ACTION_ROUTE_CHANGED = "com.divay.maina.recorder.AUDIO_ROUTE_CHANGED"
    const val EXTRA_CHANGE = "change"
    const val EXTRA_DEVICE_ID = "deviceId"
    const val EXTRA_DEVICE_TYPE = "deviceType"
    const val EXTRA_DEVICE_NAME = "deviceName"
    const val EXTRA_OCCURRED_AT = "occurredAt"

    fun emit(context: Context, change: String, device: AudioDeviceInfo) {
        context.sendBroadcast(
            Intent(ACTION_ROUTE_CHANGED)
                .setPackage(context.packageName)
                .putExtra(EXTRA_CHANGE, change)
                .putExtra(EXTRA_DEVICE_ID, device.id)
                .putExtra(EXTRA_DEVICE_TYPE, device.type)
                .putExtra(EXTRA_DEVICE_NAME, device.productName.toString())
                .putExtra(EXTRA_OCCURRED_AT, System.currentTimeMillis()),
        )
    }

    fun isExternalMicrophone(device: AudioDeviceInfo): Boolean = when (device.type) {
        AudioDeviceInfo.TYPE_USB_DEVICE,
        AudioDeviceInfo.TYPE_USB_HEADSET,
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        AudioDeviceInfo.TYPE_WIRED_HEADSET,
        -> device.isSource
        else -> false
    }
}
