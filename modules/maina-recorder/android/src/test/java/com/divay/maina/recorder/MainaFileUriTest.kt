package com.divay.maina.recorder

import org.junit.Assert.assertEquals
import org.junit.Test

class MainaFileUriTest {
    @Test
    fun resolvesJavaSingleSlashFileUri() {
        assertEquals("/data/user/0/com.divay.maina/files/capture.wav", mainaFileFromUriOrPath(
            "file:/data/user/0/com.divay.maina/files/capture.wav",
        ).path)
    }

    @Test
    fun resolvesExpoTripleSlashFileUri() {
        assertEquals("/data/user/0/com.divay.maina/files/capture.wav", mainaFileFromUriOrPath(
            "file:///data/user/0/com.divay.maina/files/capture.wav",
        ).path)
    }

    @Test
    fun preservesPlainAbsolutePath() {
        assertEquals("/data/user/0/com.divay.maina/files/capture.wav", mainaFileFromUriOrPath(
            "/data/user/0/com.divay.maina/files/capture.wav",
        ).path)
    }
}
