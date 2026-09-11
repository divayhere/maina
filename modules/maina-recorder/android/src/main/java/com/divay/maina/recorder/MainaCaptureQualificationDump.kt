package com.divay.maina.recorder

import java.io.PrintWriter

internal data class MainaCaptureQualificationStatus(
    val valid: Boolean,
    val nativeState: String,
    val presentationState: String,
    val notificationState: String,
    val clean: Boolean,
    val active: Boolean,
    val chunkIndex: Long,
    val bytesWritten: Long,
    val lastProgressAtMs: Long,
    val qualificationSession: Boolean = false,
    val qualificationEvidenceDigest: String? = null,
)

internal data class MainaPublishedNotification(
    val id: Int,
    val channelId: String?,
    val title: String?,
)

internal object MainaCaptureQualificationDump {
    const val BEGIN = "MAINA_CAPTURE_QUALIFICATION_V1"
    const val END = "END_MAINA_CAPTURE_QUALIFICATION_V1"
    const val ARG = "--maina-capture-qualification-v1"

    fun requested(args: Array<out String>): Boolean = args.size == 1 && args[0] == ARG

    private fun exactInteger(value: Any?): Long? = when (value) {
        is Byte -> value.toLong()
        is Short -> value.toLong()
        is Int -> value.toLong()
        is Long -> value
        else -> null
    }

    private fun notificationState(notifications: List<MainaPublishedNotification>): String {
        val candidates = notifications.filter { it.id == 7001 && it.channelId == "maina_recording" }
        if (candidates.size != 1) return "invalid"
        return when (candidates.single().title) {
            "Maina is ready" -> "ready"
            "Maina is recording" -> "recording"
            "Maina is paused" -> "paused"
            "Maina is saving" -> "saving"
            else -> "invalid"
        }
    }

    fun status(
        snapshot: Map<String, Any?>,
        captureState: String,
        notifications: List<MainaPublishedNotification>,
        qualificationSession: Boolean = false,
        qualificationEvidenceDigest: String? = null,
    ): MainaCaptureQualificationStatus {
        val state = (snapshot["state"] as? String)?.takeIf {
            it in setOf("idle", "ownership_pending", "paused", "recording", "error")
        }
        val presentation = when (captureState) {
            "idle" -> "ready"
            "recording" -> "recording"
            "paused" -> "paused"
            "finalizing" -> "saving"
            else -> null
        }
        val active = state == "recording"
        val published = notificationState(notifications)
        val chunkIndex = exactInteger(snapshot["chunkIndex"])
        val bytes = exactInteger(snapshot["bytesWritten"])
        val progress = exactInteger(snapshot["lastProgressAtMs"])
        val lastError = snapshot["lastError"]
        val clean = state != null && state != "error" && lastError == null
        val evidenceDigest = MainaQualificationSessionPolicy.canonicalEvidenceDigest(qualificationEvidenceDigest)
        val evidenceDigestShapeValid = qualificationEvidenceDigest == null || evidenceDigest != null
        val valid = state != null &&
            presentation != null &&
            (lastError == null || lastError is String) &&
            (chunkIndex == null || chunkIndex >= 0L) &&
            (bytes == null || bytes >= 0L) &&
            (progress == null || progress >= 0L) &&
            (state == "idle" || (chunkIndex != null && bytes != null && progress != null)) &&
            published == presentation &&
            evidenceDigestShapeValid &&
            qualificationSession == (evidenceDigest != null) &&
            when (presentation) {
                "ready" -> state == "idle"
                "recording" -> state == "recording"
                "paused" -> state == "paused" || state == "ownership_pending"
                "saving" -> state != "recording"
                else -> false
            }
        return MainaCaptureQualificationStatus(
            valid = valid,
            nativeState = state ?: "invalid",
            presentationState = presentation ?: "invalid",
            notificationState = published,
            clean = clean,
            active = active,
            chunkIndex = chunkIndex?.takeIf { it >= 0L } ?: 0L,
            bytesWritten = bytes?.takeIf { it >= 0L } ?: 0L,
            lastProgressAtMs = progress?.takeIf { it >= 0L } ?: 0L,
            qualificationSession = qualificationSession,
            qualificationEvidenceDigest = evidenceDigest,
        )
    }

    fun write(
        writer: PrintWriter,
        snapshot: Map<String, Any?>,
        captureState: String,
        notifications: List<MainaPublishedNotification>,
        qualificationSession: Boolean = false,
        qualificationEvidenceDigest: String? = null,
    ) {
        val status = status(snapshot, captureState, notifications, qualificationSession, qualificationEvidenceDigest)
        writer.println(BEGIN)
        writer.println("valid=${status.valid}")
        writer.println("nativeState=${status.nativeState}")
        writer.println("presentationState=${status.presentationState}")
        writer.println("notificationState=${status.notificationState}")
        writer.println("clean=${status.clean}")
        writer.println("active=${status.active}")
        writer.println("chunkIndex=${status.chunkIndex}")
        writer.println("bytesWritten=${status.bytesWritten}")
        writer.println("lastProgressAtMs=${status.lastProgressAtMs}")
        writer.println("qualificationSession=${status.qualificationSession}")
        writer.println("qualificationEvidenceDigest=${status.qualificationEvidenceDigest ?: "none"}")
        writer.println(END)
    }
}
