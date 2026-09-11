package com.divay.maina.recorder

import java.io.PrintWriter
import java.io.StringWriter
import org.junit.Assert.assertEquals
import org.junit.Test

class MainaCaptureQualificationDumpTest {
    @Test
    fun diagnosticDumpRequiresTheOneExactQualificationArgument() {
        assertEquals(true, MainaCaptureQualificationDump.requested(arrayOf(MainaCaptureQualificationDump.ARG)))
        assertEquals(false, MainaCaptureQualificationDump.requested(emptyArray()))
        assertEquals(false, MainaCaptureQualificationDump.requested(arrayOf("--help")))
        assertEquals(false, MainaCaptureQualificationDump.requested(arrayOf(MainaCaptureQualificationDump.ARG, "extra")))
    }

    @Test
    fun activeSnapshotRequiresBoundedProgressAndEmitsClosedStatus() {
        val output = StringWriter()
        MainaCaptureQualificationDump.write(
            PrintWriter(output),
            mapOf(
                "state" to "recording",
                "chunkIndex" to 3,
                "bytesWritten" to 4_096L,
                "lastProgressAtMs" to 8_192L,
                "meetingId" to "private-sentinel",
                "directory" to "/private/sentinel",
            ),
            "recording",
            listOf(MainaPublishedNotification(7001, "maina_recording", "Maina is recording")),
            true,
            "a".repeat(64),
        )
        assertEquals(
            listOf(
                MainaCaptureQualificationDump.BEGIN,
                "valid=true",
                "nativeState=recording",
                "presentationState=recording",
                "notificationState=recording",
                "clean=true",
                "active=true",
                "chunkIndex=3",
                "bytesWritten=4096",
                "lastProgressAtMs=8192",
                "qualificationSession=true",
                "qualificationEvidenceDigest=${"a".repeat(64)}",
                MainaCaptureQualificationDump.END,
                "",
            ).joinToString("\n"),
            output.toString(),
        )
    }

    @Test
    fun qualificationOwnershipRequiresTheExactDigestPair() {
        val snapshot = mapOf(
            "state" to "recording",
            "chunkIndex" to 0,
            "bytesWritten" to 1L,
            "lastProgressAtMs" to 1L,
        )
        val notification = listOf(MainaPublishedNotification(7001, "maina_recording", "Maina is recording"))
        assertEquals(true, MainaCaptureQualificationDump.status(
            snapshot, "recording", notification, true, "a".repeat(64),
        ).valid)
        assertEquals(false, MainaCaptureQualificationDump.status(
            snapshot, "recording", notification, true, null,
        ).valid)
        assertEquals(false, MainaCaptureQualificationDump.status(
            snapshot, "recording", notification, false, "a".repeat(64),
        ).valid)
        assertEquals(false, MainaCaptureQualificationDump.status(
            snapshot, "recording", notification, true, "A".repeat(64),
        ).valid)
        assertEquals(false, MainaCaptureQualificationDump.status(
            mapOf("state" to "idle"),
            "idle",
            listOf(MainaPublishedNotification(7001, "maina_recording", "Maina is ready")),
            false,
            "A".repeat(64),
        ).valid)
    }

    @Test
    fun idleSnapshotMayOmitProgressButUnknownOrMalformedStateFailsClosed() {
        assertEquals(
            MainaCaptureQualificationStatus(true, "idle", "ready", "ready", true, false, 0L, 0L, 0L),
            MainaCaptureQualificationDump.status(
                mapOf("state" to "idle"),
                "idle",
                listOf(MainaPublishedNotification(7001, "maina_recording", "Maina is ready")),
            ),
        )
        val recordingNotification = listOf(MainaPublishedNotification(7001, "maina_recording", "Maina is recording"))
        assertEquals(false, MainaCaptureQualificationDump.status(mapOf("state" to "private-sentinel"), "idle", emptyList()).valid)
        assertEquals(
            false,
            MainaCaptureQualificationDump.status(
                mapOf("state" to "recording", "chunkIndex" to 0, "bytesWritten" to -1L, "lastProgressAtMs" to 1L),
                "recording",
                recordingNotification,
            ).valid,
        )
        assertEquals(
            false,
            MainaCaptureQualificationDump.status(
                mapOf("state" to "recording", "chunkIndex" to 0, "bytesWritten" to 1L),
                "recording",
                recordingNotification,
            ).valid,
        )
        assertEquals(false, MainaCaptureQualificationDump.status(
            mapOf("state" to "recording", "chunkIndex" to 0, "bytesWritten" to 1.5, "lastProgressAtMs" to 1L),
            "recording",
            recordingNotification,
        ).valid)
        assertEquals(false, MainaCaptureQualificationDump.status(
            mapOf("state" to "recording", "chunkIndex" to 0, "bytesWritten" to Double.NaN, "lastProgressAtMs" to 1L),
            "recording",
            recordingNotification,
        ).valid)
        assertEquals(false, MainaCaptureQualificationDump.status(
            mapOf("state" to "recording", "chunkIndex" to 0, "bytesWritten" to Double.POSITIVE_INFINITY, "lastProgressAtMs" to 1L),
            "recording",
            recordingNotification,
        ).valid)
        val error = MainaCaptureQualificationDump.status(
            mapOf("state" to "error", "chunkIndex" to 1, "bytesWritten" to 2L, "lastProgressAtMs" to 3L, "lastError" to "private"),
            "paused",
            listOf(MainaPublishedNotification(7001, "maina_recording", "Maina is paused")),
        )
        assertEquals(false, error.valid)
        assertEquals(false, error.clean)
        assertEquals("error", error.nativeState)
        assertEquals(false, error.active)
        assertEquals(false, MainaCaptureQualificationDump.status(mapOf("state" to "idle"), "unknown", emptyList()).valid)
        assertEquals(false, MainaCaptureQualificationDump.status(mapOf("state" to "idle"), "idle", emptyList()).valid)
        assertEquals(false, MainaCaptureQualificationDump.status(
            mapOf("state" to "idle"),
            "idle",
            listOf(
                MainaPublishedNotification(7001, "maina_recording", "Maina is ready"),
                MainaPublishedNotification(7001, "maina_recording", "Maina is ready"),
            ),
        ).valid)
        assertEquals(false, MainaCaptureQualificationDump.status(
            mapOf("state" to "recording", "chunkIndex" to 0, "bytesWritten" to 1L, "lastProgressAtMs" to 1L),
            "recording",
            listOf(MainaPublishedNotification(7001, "maina_recording", "Maina is paused")),
        ).valid)
    }

    @Test
    fun unknownNativeStateIsReplacedByTheClosedInvalidEnum() {
        val privateSentinel = "PRIVATE_NATIVE_STATE_SENTINEL"
        val output = StringWriter()
        MainaCaptureQualificationDump.write(
            PrintWriter(output),
            mapOf("state" to privateSentinel),
            "idle",
            listOf(MainaPublishedNotification(7001, "maina_recording", "Maina is ready")),
        )
        assertEquals(false, output.toString().contains(privateSentinel))
        assertEquals(true, output.toString().contains("valid=false\nnativeState=invalid\n"))
    }
}
