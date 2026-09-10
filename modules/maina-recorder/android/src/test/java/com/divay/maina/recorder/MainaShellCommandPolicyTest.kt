package com.divay.maina.recorder

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MainaShellCommandPolicyTest {
    private val keys = MainaShellCommandPolicy.exactExtraKeys

    private fun allowed(
        command: String = "toggle",
        expected: String = "idle",
        current: String = expected,
        action: String? = MainaShellCommandPolicy.ACTION,
        ordered: Boolean = true,
        extraKeys: Set<String> = keys,
        replayed: Boolean = false,
    ) = MainaShellCommandPolicy.allowed(action, ordered, extraKeys, command, expected, current, replayed)

    @Test
    fun exactCommandsAreStateBound() {
        assertTrue(allowed("start", "idle"))
        assertTrue(allowed("pause", "recording"))
        assertTrue(allowed("resume", "paused"))
        assertTrue(allowed("stop", "recording"))
        assertTrue(allowed("stop", "paused"))
        assertTrue(allowed("toggle", "idle"))
        assertTrue(allowed("toggle", "recording"))
        assertTrue(allowed("toggle", "paused"))
        assertFalse(allowed("start", "recording"))
        assertFalse(allowed("resume", "idle"))
        assertFalse(allowed("stop", "idle"))
        assertFalse(allowed("unknown", "idle"))
    }

    @Test
    fun authorityAndShapeFailClosed() {
        assertFalse(allowed(action = "other"))
        assertFalse(allowed(ordered = false))
        assertFalse(allowed(extraKeys = keys - MainaShellCommandPolicy.EXTRA_NONCE))
        assertFalse(allowed(extraKeys = keys + "extra"))
        assertFalse(allowed(expected = "idle", current = "recording"))
        assertFalse(allowed(replayed = true))
    }

    @Test
    fun nonceIsBoundedAscii() {
        assertTrue(MainaShellCommandPolicy.validNonce("Abcdefghijklmnop_123"))
        assertFalse(MainaShellCommandPolicy.validNonce("short"))
        assertFalse(MainaShellCommandPolicy.validNonce("abcdefghijklmnop/private"))
        assertFalse(MainaShellCommandPolicy.validNonce("abcdefghijklmnop\n"))
        assertFalse(MainaShellCommandPolicy.validNonce("a".repeat(65)))
    }
}
