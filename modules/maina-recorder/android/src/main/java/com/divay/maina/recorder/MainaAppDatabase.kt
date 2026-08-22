package com.divay.maina.recorder

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import java.io.File

internal object MainaDatabasePathResolver {
    fun resolve(filesDir: File, legacyDatabasePath: File): File {
        // expo-sqlite's Android defaultDatabaseDirectory is
        // <filesDir>/SQLite. Keep the conventional Android databases path as
        // a compatibility fallback for any older/custom build.
        val expoDatabasePath = File(File(filesDir, "SQLite"), "maina.db")
        return when {
            expoDatabasePath.isFile -> expoDatabasePath
            legacyDatabasePath.isFile -> legacyDatabasePath
            else -> expoDatabasePath
        }
    }
}

internal class MainaAppDatabase(private val context: Context) {
    data class MeetingRow(
        val id: String,
        val startedAt: Long,
        val audioUri: String?,
    )

    data class TranscriptSummary(
        val blockCount: Int,
        val wordCount: Int,
        val hasText: Boolean,
    )

    fun getMeeting(meetingId: String): MeetingRow? = open().use { db ->
        db.rawQuery(
            "SELECT id, started_at, audio_uri FROM meetings WHERE id = ?",
            arrayOf(meetingId),
        ).use { cursor ->
            if (!cursor.moveToFirst()) return null
            MeetingRow(
                id = cursor.getString(0),
                startedAt = cursor.getLong(1),
                audioUri = cursor.getString(2),
            )
        }
    }

    fun markInterrupted(meetingId: String, error: String) = open().use { db ->
        val values = ContentValues().apply {
            put("status", "interrupted")
            put("last_error", error)
            put("updated_at", System.currentTimeMillis())
        }
        db.update("meetings", values, "id = ?", arrayOf(meetingId))
    }

    fun markTranscriptionDeferred(meetingId: String, error: String) = open().use { db ->
        val values = ContentValues().apply {
            put("status", "transcribing")
            put("last_error", error)
            put("updated_at", System.currentTimeMillis())
        }
        db.update("meetings", values, "id = ?", arrayOf(meetingId))
    }

    fun beginTranscription(
        meetingId: String,
        durationMs: Long,
        audioDurationMs: Long,
        captureEndedAt: Long?,
        segmentCount: Int,
        routeRestartCount: Int,
        windowCount: Int,
        captureGapMs: Long,
    ) = open().use { db ->
        val values = ContentValues().apply {
            put("duration_ms", durationMs)
            put("audio_duration_ms", audioDurationMs)
            if (captureEndedAt != null) put("capture_ended_at", captureEndedAt) else putNull("capture_ended_at")
            put("segment_count", segmentCount)
            put("transcribed_segments", 0)
            put("transcription_window_count", windowCount)
            put("transcription_completed_windows", 0)
            put("transcription_failed_windows", 0)
            put("restart_count", routeRestartCount)
            put("status", "transcribing")
            put("summary_status", "idle")
            putNull("last_error")
            put("updated_at", System.currentTimeMillis())
        }
        db.update("meetings", values, "id = ?", arrayOf(meetingId))
        clearTranscriptState(db, meetingId)
        // Preserve the chunk list for later re-transcribe / export flows.
        val gapValues = ContentValues().apply {
            put("last_error", if (captureGapMs > 0) "Capture gap detected: ${captureGapMs}ms" else null as String?)
            put("updated_at", System.currentTimeMillis())
        }
        if (captureGapMs > 0) db.update("meetings", gapValues, "id = ?", arrayOf(meetingId))
    }

    fun replaceRecordingSegments(
        meetingId: String,
        meetingStartedAt: Long,
        uris: List<String>,
        durationsMs: List<Long>,
    ) = open().use { db ->
        db.beginTransactionNonExclusive()
        try {
            db.delete("recording_segments", "meeting_id = ?", arrayOf(meetingId))
            var cursorAt = meetingStartedAt
            uris.forEachIndexed { index, uri ->
                val durationMs = durationsMs.getOrNull(index) ?: 0L
                val values = ContentValues().apply {
                    put("meeting_id", meetingId)
                    put("segment_index", index)
                    put("audio_uri", uri)
                    put("started_at", cursorAt)
                    put("ended_at", cursorAt + durationMs)
                    put("status", "recorded")
                    putNull("error_code")
                }
                db.insertWithOnConflict(
                    "recording_segments",
                    null,
                    values,
                    SQLiteDatabase.CONFLICT_REPLACE,
                )
                cursorAt += durationMs
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    fun appendTranscriptBlock(
        meetingId: String,
        sequence: Int,
        segmentIndex: Int,
        startedAt: Long,
        endedAt: Long,
        language: String?,
        text: String,
    ) = open().use { db ->
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return@use
        val values = ContentValues().apply {
            put("block_id", java.util.UUID.randomUUID().toString())
            put("meeting_id", meetingId)
            put("sequence", sequence)
            put("status", "final")
            put("segment_index", segmentIndex)
            put("started_at", startedAt)
            put("ended_at", endedAt)
            if (language.isNullOrBlank()) putNull("language") else put("language", language)
            putNull("speaker_id")
            put("text", trimmed)
            put("word_count", wordCount(trimmed))
            put("char_count", trimmed.length)
            put("created_at", System.currentTimeMillis())
            put("updated_at", System.currentTimeMillis())
        }
        db.insertOrThrow("transcript_blocks", null, values)
    }

    fun updateTranscriptionProgress(
        meetingId: String,
        processedSegments: Int,
        completedWindows: Int,
        failedWindows: Int,
        lastError: String?,
    ) = open().use { db ->
        val values = ContentValues().apply {
            put("transcribed_segments", processedSegments)
            put("transcription_completed_windows", completedWindows)
            put("transcription_failed_windows", failedWindows)
            if (lastError == null) putNull("last_error") else put("last_error", lastError)
            put("status", "transcribing")
            put("updated_at", System.currentTimeMillis())
        }
        db.update("meetings", values, "id = ?", arrayOf(meetingId))
    }

    fun getTranscriptSummary(meetingId: String): TranscriptSummary = open().use { db ->
        db.rawQuery(
            """
            SELECT COUNT(*) AS total,
                   COALESCE(SUM(word_count), 0) AS words,
                   COALESCE(SUM(char_count), 0) AS chars
            FROM transcript_blocks
            WHERE meeting_id = ?
            """.trimIndent(),
            arrayOf(meetingId),
        ).use { cursor ->
            cursor.moveToFirst()
            val blockCount = cursor.getInt(0)
            val wordCount = cursor.getInt(1)
            val charCount = cursor.getInt(2)
            TranscriptSummary(blockCount, wordCount, charCount > 0)
        }
    }

    fun finishTranscription(
        meetingId: String,
        durationMs: Long,
        audioDurationMs: Long,
        captureEndedAt: Long?,
        segmentCount: Int,
        processedSegments: Int,
        windowCount: Int,
        completedWindows: Int,
        failedWindows: Int,
        routeRestartCount: Int,
        finalError: String?,
        hasTranscript: Boolean,
    ) = open().use { db ->
        val values = ContentValues().apply {
            put("duration_ms", durationMs)
            put("audio_duration_ms", audioDurationMs)
            if (captureEndedAt != null) put("capture_ended_at", captureEndedAt) else putNull("capture_ended_at")
            put("segment_count", segmentCount)
            put("transcribed_segments", processedSegments)
            put("transcription_window_count", windowCount)
            put("transcription_completed_windows", completedWindows)
            put("transcription_failed_windows", failedWindows)
            put("restart_count", routeRestartCount)
            put("status", if (hasTranscript) "transcribed" else "recorded")
            // Provider configuration and the auto-summary preference live in
            // the React layer. Native ASR only publishes a durable transcript;
            // foreground reconciliation decides whether notes should be queued.
            put("summary_status", "idle")
            if (finalError == null) putNull("last_error") else put("last_error", finalError)
            put("updated_at", System.currentTimeMillis())
        }
        db.update("meetings", values, "id = ?", arrayOf(meetingId))
    }

    private fun clearTranscriptState(db: SQLiteDatabase, meetingId: String) {
        db.beginTransactionNonExclusive()
        try {
            db.delete("transcript_blocks", "meeting_id = ?", arrayOf(meetingId))
            val values = ContentValues().apply {
                putNull("transcript")
                put("transcribed_segments", 0)
                put("transcription_completed_windows", 0)
                put("transcription_failed_windows", 0)
                put("updated_at", System.currentTimeMillis())
            }
            db.update("meetings", values, "id = ?", arrayOf(meetingId))
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    private fun open(): SQLiteDatabase {
        val path = MainaDatabasePathResolver.resolve(
            filesDir = context.filesDir,
            legacyDatabasePath = context.getDatabasePath("maina.db"),
        )
        require(path.isFile) { "Maina database is not initialized yet" }
        return SQLiteDatabase.openDatabase(path.path, null, SQLiteDatabase.OPEN_READWRITE).apply {
            execSQL("PRAGMA foreign_keys = ON")
            execSQL("PRAGMA busy_timeout = 5000")
        }
    }

    private fun wordCount(text: String): Int = text
        .trim()
        .split(Regex("\\s+"))
        .count { it.isNotBlank() }
}
