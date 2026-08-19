package com.divay.maina.recorder

import android.content.Context
import android.view.InputDevice
import android.view.KeyEvent

/**
 * Matches only the dedicated POPIO / AB Shutter remote. Physical phone keys,
 * microphones exposing consumer-control HID, and arbitrary keyboards must pass
 * through untouched.
 */
internal object MainaRemoteDeviceMatcher {
    private const val PREFS_NAME = "maina-remote-device"
    private const val KEY_DESCRIPTOR = "descriptor"
    private const val KEY_VENDOR_ID = "vendor_id"
    private const val KEY_PRODUCT_ID = "product_id"
    private const val KEY_NAME = "name"

    private val bootstrapNameTokens = listOf("ab shutter", "camera360")
    private val supportedKeyCodes = setOf(
        KeyEvent.KEYCODE_VOLUME_UP,
        KeyEvent.KEYCODE_VOLUME_DOWN,
        KeyEvent.KEYCODE_CAMERA,
        KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
        KeyEvent.KEYCODE_HEADSETHOOK,
        KeyEvent.KEYCODE_MEDIA_PLAY,
        KeyEvent.KEYCODE_MEDIA_PAUSE,
        KeyEvent.KEYCODE_ENTER,
        KeyEvent.KEYCODE_DPAD_CENTER,
        KeyEvent.KEYCODE_MEDIA_STOP,
        KeyEvent.KEYCODE_MEDIA_NEXT,
    )

    fun isSupportedKey(keyCode: Int): Boolean = keyCode in supportedKeyCodes

    fun isTrusted(context: Context, device: InputDevice?): Boolean {
        if (device == null || device.isVirtual || !device.isExternal) return false
        val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val trustedDescriptor = prefs.getString(KEY_DESCRIPTOR, null)
        val descriptorMatch = !trustedDescriptor.isNullOrBlank() && device.descriptor == trustedDescriptor
        val vendorProductMatch = prefs.getInt(KEY_VENDOR_ID, -1) > 0 &&
            prefs.getInt(KEY_VENDOR_ID, -1) == device.vendorId &&
            prefs.getInt(KEY_PRODUCT_ID, -1) == device.productId
        val bootstrapMatch = matchesBootstrapName(device.name)
        if (!descriptorMatch && !vendorProductMatch && !bootstrapMatch) return false
        if (bootstrapMatch && (!descriptorMatch || !vendorProductMatch)) remember(context, device)
        return true
    }

    fun matchesBootstrapName(name: String?): Boolean {
        val normalized = name.orEmpty().trim().lowercase()
        return bootstrapNameTokens.any(normalized::contains)
    }

    fun rememberedName(context: Context): String? =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString(KEY_NAME, null)

    fun fingerprint(device: InputDevice): String =
        "${device.name} · ${device.vendorId}:${device.productId}"

    private fun remember(context: Context, device: InputDevice) {
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_DESCRIPTOR, device.descriptor)
            .putInt(KEY_VENDOR_ID, device.vendorId)
            .putInt(KEY_PRODUCT_ID, device.productId)
            .putString(KEY_NAME, device.name)
            .apply()
    }
}
