package com.divay.maina.recorder

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import java.util.UUID

/**
 * Durable hand-off between the service-owned ASR process and the Expo runtime.
 *
 * This intentionally never touches `maina.db`: Expo SQLite owns that database.
 * The foreground JS runtime reads a completed native run and imports it in one
 * transaction, which keeps a process restart from producing a half-written UI
 * transcript or a cross-driver SQLite crash.
 */
internal class MainaPostProcessingOutbox(context: Context) :
    SQLiteOpenHelper(context.applicationContext, DB_NAME, null, DB_VERSION) {

    data class StartResult(
        val runId: String,
        val alreadyTerminal: Boolean,
        val resumed: Boolean,
        val completedWindowKeys: Set<String>,
    )

    fun begin(
        meetingId: String,
        meetingStartedAt: Long,
        captureEndedAt: Long?,
        durationMs: Long,
        audioDurationMs: Long,
        segmentCount: Int,
        windowCount: Int,
        routeRestartCount: Int,
        captureGapMs: Long,
    ): StartResult {
        writableDatabase.beginTransaction()
        try {
            var existingRunId: String? = null
            var existingState: String? = null
            var existingWindowCount = 0
            writableDatabase.rawQuery(
                "SELECT run_id, state, window_count FROM runs WHERE meeting_id = ?",
                arrayOf(meetingId),
            ).use { cursor ->
                if (cursor.moveToFirst()) {
                    existingRunId = cursor.getString(0)
                    existingState = cursor.getString(1)
                    existingWindowCount = cursor.getInt(2)
                }
            }
            if (existingRunId != null && existingState in TERMINAL_STATES) {
                writableDatabase.setTransactionSuccessful()
                return StartResult(existingRunId!!, true, false, emptySet())
            }
            if (existingRunId != null && existingWindowCount == windowCount) {
                // A killed/deferred private ASR process resumes the same run.
                // Completed windows and blocks stay intact; only unfinished or
                // previously failed windows are decoded again.
                writableDatabase.delete(
                    "window_results",
                    "meeting_id = ? AND run_id = ? AND state = ?",
                    arrayOf(meetingId, existingRunId, WINDOW_FAILED),
                )
                val completed = completedWindowKeys(writableDatabase, meetingId, existingRunId!!)
                writableDatabase.update(
                    "runs",
                    ContentValues().apply {
                        put("state", STATE_RUNNING)
                        put("meeting_started_at", meetingStartedAt)
                        if (captureEndedAt == null) putNull("capture_ended_at") else put("capture_ended_at", captureEndedAt)
                        put("duration_ms", durationMs)
                        put("audio_duration_ms", audioDurationMs)
                        put("segment_count", segmentCount)
                        put("completed_windows", completed.size)
                        put("failed_windows", 0)
                        put("route_restart_count", routeRestartCount)
                        put("capture_gap_ms", captureGapMs)
                        putNull("last_error")
                        put("updated_at", System.currentTimeMillis())
                    },
                    "meeting_id = ?",
                    arrayOf(meetingId),
                )
                writableDatabase.setTransactionSuccessful()
                return StartResult(existingRunId!!, false, true, completed)
            }
            val runId = UUID.randomUUID().toString()
            writableDatabase.delete("blocks", "meeting_id = ?", arrayOf(meetingId))
            writableDatabase.delete("window_results", "meeting_id = ?", arrayOf(meetingId))
            writableDatabase.insertWithOnConflict(
                "runs",
                null,
                ContentValues().apply {
                    put("meeting_id", meetingId)
                    put("run_id", runId)
                    put("state", STATE_RUNNING)
                    put("meeting_started_at", meetingStartedAt)
                    if (captureEndedAt == null) putNull("capture_ended_at") else put("capture_ended_at", captureEndedAt)
                    put("duration_ms", durationMs)
                    put("audio_duration_ms", audioDurationMs)
                    put("segment_count", segmentCount)
                    put("processed_segments", 0)
                    put("window_count", windowCount)
                    put("completed_windows", 0)
                    put("failed_windows", 0)
                    put("route_restart_count", routeRestartCount)
                    put("capture_gap_ms", captureGapMs)
                    putNull("last_error")
                    put("updated_at", System.currentTimeMillis())
                },
                SQLiteDatabase.CONFLICT_REPLACE,
            )
            writableDatabase.setTransactionSuccessful()
            return StartResult(runId, false, false, emptySet())
        } finally {
            writableDatabase.endTransaction()
        }
    }

    fun appendBlock(
        meetingId: String,
        runId: String,
        sequence: Int,
        segmentIndex: Int,
        startedAt: Long,
        endedAt: Long,
        language: String,
        text: String,
    ) {
        if (text.isBlank()) return
        writableDatabase.insertWithOnConflict(
            "blocks",
            null,
            ContentValues().apply {
                put("meeting_id", meetingId)
                put("run_id", runId)
                put("sequence", sequence)
                put("segment_index", segmentIndex)
                put("started_at", startedAt)
                put("ended_at", endedAt)
                put("language", language)
                put("text", text.trim())
            },
            SQLiteDatabase.CONFLICT_REPLACE,
        )
    }

    fun clearWindowBlocks(meetingId: String, runId: String, baseSequence: Int) =
        writableDatabase.delete(
            "blocks",
            "meeting_id = ? AND run_id = ? AND sequence >= ? AND sequence <= ?",
            arrayOf(meetingId, runId, baseSequence.toString(), (baseSequence + 1).toString()),
        )

    fun markWindow(
        meetingId: String,
        runId: String,
        segmentIndex: Int,
        windowIndex: Int,
        completed: Boolean,
        error: String?,
    ) = writableDatabase.insertWithOnConflict(
        "window_results",
        null,
        ContentValues().apply {
            put("meeting_id", meetingId)
            put("run_id", runId)
            put("segment_index", segmentIndex)
            put("window_index", windowIndex)
            put("state", if (completed) WINDOW_COMPLETE else WINDOW_FAILED)
            if (error == null) putNull("last_error") else put("last_error", error)
            put("updated_at", System.currentTimeMillis())
        },
        SQLiteDatabase.CONFLICT_REPLACE,
    )

    fun lastBlockTextBefore(meetingId: String, runId: String, sequence: Int): String = readableDatabase.rawQuery(
        """SELECT text FROM blocks
           WHERE meeting_id = ? AND run_id = ? AND sequence < ?
           ORDER BY sequence DESC LIMIT 1""",
        arrayOf(meetingId, runId, sequence.toString()),
    ).use { cursor -> if (cursor.moveToFirst()) cursor.getString(0).orEmpty() else "" }

    fun updateProgress(
        meetingId: String,
        processedSegments: Int,
        completedWindows: Int,
        failedWindows: Int,
        lastError: String?,
    ) = writableDatabase.update(
        "runs",
        ContentValues().apply {
            put("processed_segments", processedSegments)
            put("completed_windows", completedWindows)
            put("failed_windows", failedWindows)
            if (lastError == null) putNull("last_error") else put("last_error", lastError)
            put("updated_at", System.currentTimeMillis())
        },
        "meeting_id = ?",
        arrayOf(meetingId),
    )

    fun finish(
        meetingId: String,
        processedSegments: Int,
        completedWindows: Int,
        failedWindows: Int,
        lastError: String?,
    ) = writableDatabase.update(
        "runs",
        ContentValues().apply {
            put("state", if (failedWindows == 0) STATE_COMPLETE else STATE_PARTIAL)
            put("processed_segments", processedSegments)
            put("completed_windows", completedWindows)
            put("failed_windows", failedWindows)
            if (lastError == null) putNull("last_error") else put("last_error", lastError)
            put("updated_at", System.currentTimeMillis())
        },
        "meeting_id = ?",
        arrayOf(meetingId),
    )

    fun defer(meetingId: String, error: String) = writableDatabase.update(
        "runs",
        ContentValues().apply {
            put("state", STATE_DEFERRED)
            put("last_error", error)
            put("updated_at", System.currentTimeMillis())
        },
        "meeting_id = ?",
        arrayOf(meetingId),
    )

    fun read(meetingId: String): Map<String, Any?>? = readableDatabase.rawQuery(
        """SELECT run_id, state, meeting_started_at, capture_ended_at, duration_ms,
                  audio_duration_ms, segment_count, processed_segments, window_count,
                  completed_windows, failed_windows, route_restart_count, capture_gap_ms,
                  last_error, updated_at
           FROM runs WHERE meeting_id = ?""",
        arrayOf(meetingId),
    ).use { run ->
        if (!run.moveToFirst()) return null
        val runId = run.getString(0)
        val blocks = mutableListOf<Map<String, Any?>>()
        readableDatabase.rawQuery(
            """SELECT sequence, segment_index, started_at, ended_at, language, text
               FROM blocks WHERE meeting_id = ? AND run_id = ? ORDER BY sequence ASC""",
            arrayOf(meetingId, runId),
        ).use { cursor ->
            while (cursor.moveToNext()) {
                blocks += mapOf(
                    "sequence" to cursor.getInt(0),
                    "segmentIndex" to cursor.getInt(1),
                    "startedAt" to cursor.getLong(2),
                    "endedAt" to cursor.getLong(3),
                    "language" to cursor.getString(4),
                    "text" to cursor.getString(5),
                )
            }
        }
        val state = run.getString(1)
        mapOf(
            "meetingId" to meetingId,
            "runId" to runId,
            "state" to state,
            // This survives process isolation; a static field in :asr cannot
            // truthfully describe activity to the main React Native process.
            "active" to (
                state == STATE_RUNNING
                    && System.currentTimeMillis() - run.getLong(14) <= ACTIVE_HEARTBEAT_MAX_AGE_MS
            ),
            "meetingStartedAt" to run.getLong(2),
            "captureEndedAt" to if (run.isNull(3)) null else run.getLong(3),
            "durationMs" to run.getLong(4),
            "audioDurationMs" to run.getLong(5),
            "segmentCount" to run.getInt(6),
            "processedSegments" to run.getInt(7),
            "windowCount" to run.getInt(8),
            "completedWindows" to run.getInt(9),
            "failedWindows" to run.getInt(10),
            "routeRestartCount" to run.getInt(11),
            "captureGapMs" to run.getLong(12),
            "lastError" to if (run.isNull(13)) null else run.getString(13),
            "updatedAt" to run.getLong(14),
            "blocks" to blocks,
        )
    }

    /**
     * The Expo runtime calls this only after its own SQLite transaction has
     * committed the immutable result. Keeping the native row until then makes
     * an app/process crash recoverable; removing it afterwards prevents a
     * foreground reconciliation poll from repeatedly importing the same run.
     */
    fun acknowledge(meetingId: String, runId: String): Boolean {
        writableDatabase.beginTransaction()
        try {
            val deleted = writableDatabase.delete(
                "runs",
                "meeting_id = ? AND run_id = ? AND state IN (?, ?)",
                arrayOf(meetingId, runId, STATE_COMPLETE, STATE_PARTIAL),
            )
            if (deleted > 0) {
                writableDatabase.delete(
                    "blocks",
                    "meeting_id = ? AND run_id = ?",
                    arrayOf(meetingId, runId),
                )
                writableDatabase.delete(
                    "window_results",
                    "meeting_id = ? AND run_id = ?",
                    arrayOf(meetingId, runId),
                )
            }
            writableDatabase.setTransactionSuccessful()
            return deleted > 0
        } finally {
            writableDatabase.endTransaction()
        }
    }

    override fun onConfigure(db: SQLiteDatabase) {
        db.enableWriteAheadLogging()
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """CREATE TABLE runs (
                meeting_id TEXT PRIMARY KEY NOT NULL,
                run_id TEXT NOT NULL,
                state TEXT NOT NULL,
                meeting_started_at INTEGER NOT NULL,
                capture_ended_at INTEGER,
                duration_ms INTEGER NOT NULL,
                audio_duration_ms INTEGER NOT NULL,
                segment_count INTEGER NOT NULL,
                processed_segments INTEGER NOT NULL,
                window_count INTEGER NOT NULL,
                completed_windows INTEGER NOT NULL,
                failed_windows INTEGER NOT NULL,
                route_restart_count INTEGER NOT NULL,
                capture_gap_ms INTEGER NOT NULL,
                last_error TEXT,
                updated_at INTEGER NOT NULL
            )""",
        )
        db.execSQL(
            """CREATE TABLE blocks (
                meeting_id TEXT NOT NULL,
                run_id TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                segment_index INTEGER NOT NULL,
                started_at INTEGER NOT NULL,
                ended_at INTEGER NOT NULL,
                language TEXT NOT NULL,
                text TEXT NOT NULL,
                PRIMARY KEY (meeting_id, run_id, sequence)
            )""",
        )
        createWindowResultsTable(db)
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) createWindowResultsTable(db)
    }

    private fun createWindowResultsTable(db: SQLiteDatabase) {
        db.execSQL(
            """CREATE TABLE IF NOT EXISTS window_results (
                meeting_id TEXT NOT NULL,
                run_id TEXT NOT NULL,
                segment_index INTEGER NOT NULL,
                window_index INTEGER NOT NULL,
                state TEXT NOT NULL,
                last_error TEXT,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (meeting_id, run_id, segment_index, window_index)
            )""",
        )
    }

    private fun completedWindowKeys(
        db: SQLiteDatabase,
        meetingId: String,
        runId: String,
    ): Set<String> = db.rawQuery(
        """SELECT segment_index, window_index FROM window_results
           WHERE meeting_id = ? AND run_id = ? AND state = ?""",
        arrayOf(meetingId, runId, WINDOW_COMPLETE),
    ).use { cursor ->
        buildSet {
            while (cursor.moveToNext()) add(windowKey(cursor.getInt(0), cursor.getInt(1)))
        }
    }

    companion object {
        private const val DB_NAME = "maina-native-postprocess.db"
        private const val DB_VERSION = 2
        const val STATE_RUNNING = "running"
        const val STATE_COMPLETE = "complete"
        const val STATE_PARTIAL = "partial"
        const val STATE_DEFERRED = "deferred"
        const val WINDOW_COMPLETE = "complete"
        const val WINDOW_FAILED = "failed"
        val TERMINAL_STATES = setOf(STATE_COMPLETE, STATE_PARTIAL)
        private const val ACTIVE_HEARTBEAT_MAX_AGE_MS = 120_000L

        fun windowKey(segmentIndex: Int, windowIndex: Int) = "$segmentIndex:$windowIndex"

        @Volatile private var shared: MainaPostProcessingOutbox? = null
        fun shared(context: Context): MainaPostProcessingOutbox = shared
            ?: synchronized(this) {
                shared ?: MainaPostProcessingOutbox(context).also { shared = it }
            }
    }
}
