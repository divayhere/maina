package com.divay.maina.recorder

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URI
import java.util.UUID

internal data class DiagnosticConfig(
    val enabled: Boolean,
    val supabaseUrl: String,
    val publishableKey: String,
    val bucket: String,
    val installId: String,
    val appSessionId: String,
    val appVersion: String,
    val buildNumber: String,
    val gitSha: String,
    val device: String,
    val platform: String,
    val retentionDays: Int,
)

internal data class OutboxRecord(
    val recordId: String,
    val targetTable: String,
    val payload: String,
)

internal data class ArtifactRecord(
    val artifactId: String,
    val meetingId: String,
    val segmentIndex: Int?,
    val kind: String,
    val sourcePath: String,
    val preparedPath: String?,
    val objectPath: String?,
    val contentType: String?,
    val codec: String?,
    val durationMs: Long,
    val bytes: Long?,
    val sha256: String?,
    val status: String,
    val expiresAt: Long?,
)

/**
 * A private native outbox. It deliberately does not share the app's SQLite
 * connection: WorkManager can drain this database after React Native is gone.
 */
internal class DiagnosticsStore(context: Context) :
    SQLiteOpenHelper(context.applicationContext, DB_NAME, null, DB_VERSION) {
    private val appContext = context.applicationContext
    private val prefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    override fun onConfigure(db: SQLiteDatabase) {
        db.setForeignKeyConstraintsEnabled(true)
        db.enableWriteAheadLogging()
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """CREATE TABLE outbox_records (
                record_id TEXT PRIMARY KEY NOT NULL,
                target_table TEXT NOT NULL,
                payload TEXT NOT NULL,
                priority INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                last_attempt_at INTEGER
            )""",
        )
        db.execSQL(
            """CREATE INDEX idx_outbox_target_created
               ON outbox_records(target_table, priority DESC, created_at ASC)""",
        )
        db.execSQL(
            """CREATE TABLE artifacts (
                artifact_id TEXT PRIMARY KEY NOT NULL,
                meeting_id TEXT NOT NULL,
                segment_index INTEGER,
                kind TEXT NOT NULL,
                source_path TEXT NOT NULL,
                prepared_path TEXT,
                object_path TEXT,
                content_type TEXT,
                codec TEXT,
                duration_ms INTEGER NOT NULL DEFAULT 0,
                bytes INTEGER,
                sha256 TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                attempts INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                last_attempt_at INTEGER,
                uploaded_at INTEGER,
                expires_at INTEGER,
                source_deleted INTEGER NOT NULL DEFAULT 0,
                remote_deleted INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            )""",
        )
        db.execSQL(
            """CREATE INDEX idx_artifacts_status_created
               ON artifacts(status, created_at ASC)""",
        )
        db.execSQL(
            """CREATE INDEX idx_artifacts_meeting
               ON artifacts(meeting_id, kind, status)""",
        )
        db.execSQL(
            """CREATE TABLE finalized_runs (
                meeting_id TEXT PRIMARY KEY NOT NULL,
                finalized_at INTEGER NOT NULL
            )""",
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        var version = oldVersion
        if (version < 2) {
            db.execSQL("ALTER TABLE outbox_records ADD COLUMN last_attempt_at INTEGER")
            db.execSQL("ALTER TABLE artifacts ADD COLUMN last_attempt_at INTEGER")
            version = 2
        }
        check(version == newVersion) {
            "Unsupported diagnostics database migration $oldVersion -> $newVersion"
        }
    }

    fun configure(raw: Map<String, Any?>) {
        val installId = prefs.getString(KEY_INSTALL_ID, null) ?: UUID.randomUUID().toString()
        prefs.edit()
            .putString(KEY_INSTALL_ID, installId)
            .putBoolean(KEY_ENABLED, raw.boolean("enabled"))
            .putString(KEY_URL, raw.string("supabaseUrl").trimEnd('/'))
            .putString(KEY_API_KEY, raw.string("publishableKey"))
            .putString(KEY_BUCKET, raw.string("bucket"))
            .putString(KEY_APP_SESSION_ID, raw.string("appSessionId"))
            .putString(KEY_APP_VERSION, raw.string("appVersion"))
            .putString(KEY_BUILD_NUMBER, raw.string("buildNumber"))
            .putString(KEY_GIT_SHA, raw.string("gitSha"))
            .putString(KEY_DEVICE, raw.string("device"))
            .putString(KEY_PLATFORM, raw.string("platform"))
            .putInt(KEY_RETENTION_DAYS, raw.int("retentionDays").coerceIn(1, 90))
            .apply()
    }

    fun config(): DiagnosticConfig = DiagnosticConfig(
        enabled = prefs.getBoolean(KEY_ENABLED, false),
        supabaseUrl = prefs.getString(KEY_URL, "") ?: "",
        publishableKey = prefs.getString(KEY_API_KEY, "") ?: "",
        bucket = prefs.getString(KEY_BUCKET, "maina-diagnostics") ?: "maina-diagnostics",
        installId = installId(),
        appSessionId = prefs.getString(KEY_APP_SESSION_ID, "") ?: "",
        appVersion = prefs.getString(KEY_APP_VERSION, "?") ?: "?",
        buildNumber = prefs.getString(KEY_BUILD_NUMBER, "?") ?: "?",
        gitSha = prefs.getString(KEY_GIT_SHA, "unknown") ?: "unknown",
        device = prefs.getString(KEY_DEVICE, "unknown") ?: "unknown",
        platform = prefs.getString(KEY_PLATFORM, "android") ?: "android",
        retentionDays = prefs.getInt(KEY_RETENTION_DAYS, 7).coerceIn(1, 90),
    )

    fun enqueueEvents(events: List<Map<String, Any?>>): Int {
        if (events.isEmpty()) return 0
        val config = config()
        var inserted = 0
        writableDatabase.beginTransaction()
        try {
            events.forEach { event ->
                val eventId = event.string("eventId")
                if (eventId.isBlank()) return@forEach
                val payload = JSONObject().apply {
                    put("event_id", eventId)
                    put("occurred_at", event.string("occurredAt"))
                    put("elapsed_ms", event.long("elapsedMs"))
                    put("sequence", event.long("sequence"))
                    put("level", event.string("level"))
                    put("category", event.string("category"))
                    put("event_name", event.string("eventName"))
                    put("message", event.string("message"))
                    putNullable("meeting_id", event["meetingId"])
                    putNullable("recording_session_id", event["recordingSessionId"])
                    putNullable("segment_index", event["segmentIndex"])
                    putNullable("duration_ms", event["durationMs"])
                    put("payload", toJsonValue(event["payload"]) ?: JSONObject())
                    addBase(config)
                }
                if (insertOutbox("diagnostic_events", eventId, payload, priorityFor(event.string("level")))) {
                    inserted += 1
                }
            }
            writableDatabase.setTransactionSuccessful()
        } finally {
            writableDatabase.endTransaction()
        }
        return inserted
    }

    fun queueAudioArtifact(artifactId: String, raw: Map<String, Any?>) {
        val source = uriToPath(raw.string("sourceUri"))
        require(source.isNotBlank()) { "Audio artifact source is missing" }
        val values = ContentValues().apply {
            put("artifact_id", artifactId)
            put("meeting_id", raw.string("meetingId"))
            put("segment_index", raw.int("segmentIndex"))
            put("kind", "audio")
            put("source_path", source)
            put("duration_ms", raw.long("durationMs"))
            put("status", "pending")
            put("created_at", System.currentTimeMillis())
        }
        writableDatabase.insertWithOnConflict("artifacts", null, values, SQLiteDatabase.CONFLICT_IGNORE)
    }

    fun queueTextArtifact(artifactId: String, raw: Map<String, Any?>) {
        val meetingId = raw.string("meetingId")
        val kind = raw.string("kind").ifBlank { "transcript" }
        val dir = File(appContext.filesDir, "maina-diagnostics-artifacts").apply { mkdirs() }
        val source = File(dir, "$artifactId.txt")
        source.writeText(raw.string("content"), Charsets.UTF_8)
        val values = ContentValues().apply {
            put("artifact_id", artifactId)
            put("meeting_id", meetingId)
            putNull("segment_index")
            put("kind", kind)
            put("source_path", source.absolutePath)
            put("prepared_path", source.absolutePath)
            put("content_type", "text/plain")
            put("codec", "utf-8")
            put("duration_ms", 0)
            put("status", "prepared")
            put("created_at", System.currentTimeMillis())
        }
        writableDatabase.insertWithOnConflict("artifacts", null, values, SQLiteDatabase.CONFLICT_IGNORE)
    }

    fun finalizeRun(raw: Map<String, Any?>) {
        val meetingId = raw.string("meetingId")
        require(meetingId.isNotBlank()) { "Diagnostic run meeting id is missing" }
        val config = config()
        val runId = raw.string("runId").ifBlank { UUID.randomUUID().toString() }
        val payload = JSONObject().apply {
            put("run_id", runId)
            put("meeting_id", meetingId)
            put("started_at", raw.string("startedAt"))
            put("ended_at", raw.string("endedAt"))
            put("status", raw.string("status"))
            put("wall_duration_ms", raw.long("wallDurationMs"))
            put("audio_duration_ms", raw.long("audioDurationMs"))
            put("expected_segments", raw.int("expectedSegments"))
            put("closed_segments", raw.int("closedSegments"))
            put("uploaded_segments", raw.int("uploadedSegments"))
            put("transcript_words", raw.int("transcriptWords"))
            put("recognizer_restarts", raw.int("recognizerRestarts"))
            put("recognizer_downtime_ms", raw.long("recognizerDowntimeMs"))
            put("measured_gap_ms", raw.long("measuredGapMs"))
            put("payload", toJsonValue(raw["payload"]) ?: JSONObject())
            addBase(config)
        }
        writableDatabase.beginTransaction()
        try {
            writableDatabase.execSQL(
                "INSERT OR REPLACE INTO finalized_runs(meeting_id, finalized_at) VALUES (?, ?)",
                arrayOf<Any>(meetingId, System.currentTimeMillis()),
            )
            insertOutbox("diagnostic_runs", runId, payload, 2)
            writableDatabase.setTransactionSuccessful()
        } finally {
            writableDatabase.endTransaction()
        }
    }

    fun nextOutbox(targetTable: String, limit: Int): List<OutboxRecord> {
        val result = mutableListOf<OutboxRecord>()
        readableDatabase.query(
            "outbox_records",
            arrayOf("record_id", "target_table", "payload"),
            "target_table = ?",
            arrayOf(targetTable),
            null,
            null,
            "priority DESC, created_at ASC",
            limit.toString(),
        ).use { cursor ->
            while (cursor.moveToNext()) {
                result += OutboxRecord(cursor.getString(0), cursor.getString(1), cursor.getString(2))
            }
        }
        return result
    }

    fun acknowledgeOutbox(recordIds: List<String>) {
        if (recordIds.isEmpty()) return
        writableDatabase.beginTransaction()
        try {
            recordIds.forEach { id -> writableDatabase.delete("outbox_records", "record_id = ?", arrayOf(id)) }
            writableDatabase.setTransactionSuccessful()
        } finally {
            writableDatabase.endTransaction()
        }
    }

    fun markOutboxFailure(recordIds: List<String>, error: String) {
        recordIds.forEach { id ->
            writableDatabase.execSQL(
                """UPDATE outbox_records
                   SET attempts = attempts + 1, last_error = ?, last_attempt_at = ?
                   WHERE record_id = ?""",
                arrayOf(error.take(1000), System.currentTimeMillis(), id),
            )
        }
        setLastError(error)
    }

    fun pendingArtifacts(limit: Int = 4): List<ArtifactRecord> = queryArtifacts(
        "status IN ('pending', 'prepared', 'failed') AND attempts < 8",
        emptyArray(),
        "created_at ASC",
        limit,
    )

    fun expiredArtifacts(now: Long, limit: Int = 20): List<ArtifactRecord> = queryArtifacts(
        "status = 'uploaded' AND remote_deleted = 0 AND expires_at IS NOT NULL AND expires_at <= ?",
        arrayOf(now.toString()),
        "expires_at ASC",
        limit,
    )

    fun retryFailedArtifacts(): Int {
        val values = ContentValues().apply {
            put("status", "pending")
            put("attempts", 0)
            putNull("last_error")
            putNull("last_attempt_at")
        }
        val changed = writableDatabase.update("artifacts", values, "status = 'failed'", null)
        if (changed > 0) prefs.edit().remove(KEY_LAST_ERROR).apply()
        return changed
    }

    fun markArtifactPrepared(artifactId: String, prepared: PreparedArtifact): String {
        val objectPath = objectPathFor(artifactId, prepared.extension)
        val values = ContentValues().apply {
            put("prepared_path", prepared.path)
            put("content_type", prepared.contentType)
            put("codec", prepared.codec)
            put("duration_ms", prepared.durationMs)
            put("bytes", prepared.bytes)
            put("sha256", prepared.sha256)
            put("object_path", objectPath)
            put("status", "prepared")
            putNull("last_error")
        }
        writableDatabase.update("artifacts", values, "artifact_id = ?", arrayOf(artifactId))
        return objectPath
    }

    fun markArtifactUploaded(artifact: ArtifactRecord, uploaded: PreparedArtifact) {
        val now = System.currentTimeMillis()
        val expiresAt = now + config().retentionDays * DAY_MS
        val objectPath = artifact.objectPath ?: objectPathFor(artifact.artifactId, uploaded.extension)
        val config = config()
        val remote = JSONObject().apply {
            put("artifact_id", artifact.artifactId)
            put("meeting_id", artifact.meetingId)
            putNullable("segment_index", artifact.segmentIndex)
            put("kind", artifact.kind)
            put("object_path", objectPath)
            put("content_type", uploaded.contentType)
            put("codec", uploaded.codec)
            put("bytes", uploaded.bytes)
            put("sha256", uploaded.sha256)
            put("duration_ms", uploaded.durationMs)
            put("uploaded_at", isoTime(now))
            put("expires_at", isoTime(expiresAt))
            put("payload", JSONObject())
            addBase(config)
        }
        writableDatabase.beginTransaction()
        try {
            val values = ContentValues().apply {
                put("prepared_path", uploaded.path)
                put("object_path", objectPath)
                put("content_type", uploaded.contentType)
                put("codec", uploaded.codec)
                put("duration_ms", uploaded.durationMs)
                put("bytes", uploaded.bytes)
                put("sha256", uploaded.sha256)
                put("status", "uploaded")
                put("uploaded_at", now)
                put("expires_at", expiresAt)
                putNull("last_error")
            }
            writableDatabase.update("artifacts", values, "artifact_id = ?", arrayOf(artifact.artifactId))
            insertOutbox("diagnostic_artifacts", artifact.artifactId, remote, 2)
            writableDatabase.setTransactionSuccessful()
        } finally {
            writableDatabase.endTransaction()
        }
    }

    fun markArtifactFailure(artifactId: String, error: String) {
        writableDatabase.execSQL(
            """UPDATE artifacts
               SET status = 'failed', attempts = attempts + 1, last_error = ?, last_attempt_at = ?
               WHERE artifact_id = ?""",
            arrayOf(error.take(1000), System.currentTimeMillis(), artifactId),
        )
        setLastError(error)
    }

    fun markRemoteDeleted(artifactId: String) {
        writableDatabase.execSQL(
            "UPDATE artifacts SET remote_deleted = 1 WHERE artifact_id = ?",
            arrayOf(artifactId),
        )
    }

    /** Delete local sources only after final transcript + every queued artifact uploaded. */
    fun cleanupSafeLocalSources(): List<String> {
        val meetings = mutableListOf<String>()
        readableDatabase.rawQuery(
            """SELECT fr.meeting_id
               FROM finalized_runs fr
               WHERE EXISTS (
                 SELECT 1 FROM artifacts t
                 WHERE t.meeting_id = fr.meeting_id
                   AND t.kind = 'transcript' AND t.status = 'uploaded'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM artifacts a
                 WHERE a.meeting_id = fr.meeting_id AND a.status != 'uploaded'
               )""",
            null,
        ).use { cursor -> while (cursor.moveToNext()) meetings += cursor.getString(0) }

        meetings.forEach { meetingId ->
            val artifacts = queryArtifacts("meeting_id = ? AND source_deleted = 0", arrayOf(meetingId), "created_at", 1000)
            artifacts.forEach { artifact ->
                val source = File(artifact.sourcePath)
                val sourceRemoved = !source.exists() || runCatching { source.delete() }.getOrDefault(false)
                val prepared = artifact.preparedPath
                    ?.takeIf { it != artifact.sourcePath }
                    ?.let(::File)
                val preparedRemoved = prepared == null || !prepared.exists() ||
                    runCatching { prepared.delete() }.getOrDefault(false)
                if (sourceRemoved && preparedRemoved) {
                    writableDatabase.execSQL(
                        "UPDATE artifacts SET source_deleted = 1 WHERE artifact_id = ?",
                        arrayOf(artifact.artifactId),
                    )
                } else {
                    setLastError("Could not delete local source for artifact ${artifact.artifactId}")
                }
            }
        }
        return meetings
    }

    fun meetingsWithDeletedAudio(): List<String> {
        val result = mutableListOf<String>()
        readableDatabase.rawQuery(
            "SELECT DISTINCT meeting_id FROM artifacts WHERE kind = 'audio' AND source_deleted = 1",
            null,
        ).use { cursor -> while (cursor.moveToNext()) result += cursor.getString(0) }
        return result
    }

    fun status(): Map<String, Any?> {
        val pendingEvents = scalarLong("SELECT COUNT(*) FROM outbox_records").toInt()
        val pendingArtifacts = scalarLong("SELECT COUNT(*) FROM artifacts WHERE status IN ('pending','prepared')").toInt()
        val failedArtifacts = scalarLong("SELECT COUNT(*) FROM artifacts WHERE status = 'failed'").toInt()
        val exhaustedArtifacts = scalarLong("SELECT COUNT(*) FROM artifacts WHERE status = 'failed' AND attempts >= 8").toInt()
        val oldestPendingAt = scalarNullableLong(
            """SELECT MIN(created_at) FROM (
                 SELECT created_at FROM outbox_records
                 UNION ALL
                 SELECT created_at FROM artifacts WHERE status IN ('pending','prepared','failed')
               )""",
        )
        val lastAttemptAt = scalarNullableLong(
            """SELECT MAX(last_attempt_at) FROM (
                 SELECT last_attempt_at FROM outbox_records
                 UNION ALL
                 SELECT last_attempt_at FROM artifacts
               )""",
        )
        return mapOf(
            "enabled" to config().enabled,
            "installId" to installId(),
            "pendingEvents" to pendingEvents,
            "pendingArtifacts" to pendingArtifacts,
            "failedArtifacts" to failedArtifacts,
            "exhaustedArtifacts" to exhaustedArtifacts,
            "oldestPendingAt" to oldestPendingAt,
            "lastAttemptAt" to lastAttemptAt,
            "lastUploadAt" to prefs.getLong(KEY_LAST_UPLOAD_AT, 0L).takeIf { it > 0L },
            "lastError" to prefs.getString(KEY_LAST_ERROR, null),
        )
    }

    fun markUploadSuccess() {
        val editor = prefs.edit().putLong(KEY_LAST_UPLOAD_AT, System.currentTimeMillis())
        if (scalarLong("SELECT COUNT(*) FROM artifacts WHERE status = 'failed'") == 0L) {
            editor.remove(KEY_LAST_ERROR)
        }
        editor.apply()
    }

    fun setLastError(error: String) {
        prefs.edit().putString(KEY_LAST_ERROR, error.take(1000)).apply()
    }

    private fun insertOutbox(target: String, id: String, payload: JSONObject, priority: Int): Boolean {
        val values = ContentValues().apply {
            put("record_id", id)
            put("target_table", target)
            put("payload", payload.toString())
            put("priority", priority)
            put("created_at", System.currentTimeMillis())
        }
        return writableDatabase.insertWithOnConflict(
            "outbox_records",
            null,
            values,
            SQLiteDatabase.CONFLICT_IGNORE,
        ) != -1L
    }

    private fun queryArtifacts(
        selection: String,
        args: Array<String>,
        order: String,
        limit: Int,
    ): List<ArtifactRecord> {
        val result = mutableListOf<ArtifactRecord>()
        readableDatabase.query(
            "artifacts",
            arrayOf(
                "artifact_id", "meeting_id", "segment_index", "kind", "source_path",
                "prepared_path", "object_path", "content_type", "codec", "duration_ms",
                "bytes", "sha256", "status", "expires_at",
            ),
            selection,
            args,
            null,
            null,
            order,
            limit.toString(),
        ).use { cursor ->
            while (cursor.moveToNext()) {
                result += ArtifactRecord(
                    artifactId = cursor.getString(0),
                    meetingId = cursor.getString(1),
                    segmentIndex = if (cursor.isNull(2)) null else cursor.getInt(2),
                    kind = cursor.getString(3),
                    sourcePath = cursor.getString(4),
                    preparedPath = if (cursor.isNull(5)) null else cursor.getString(5),
                    objectPath = if (cursor.isNull(6)) null else cursor.getString(6),
                    contentType = if (cursor.isNull(7)) null else cursor.getString(7),
                    codec = if (cursor.isNull(8)) null else cursor.getString(8),
                    durationMs = cursor.getLong(9),
                    bytes = if (cursor.isNull(10)) null else cursor.getLong(10),
                    sha256 = if (cursor.isNull(11)) null else cursor.getString(11),
                    status = cursor.getString(12),
                    expiresAt = if (cursor.isNull(13)) null else cursor.getLong(13),
                )
            }
        }
        return result
    }

    private fun objectPathFor(artifactId: String, extension: String): String {
        val row = readableDatabase.rawQuery(
            "SELECT meeting_id, kind, segment_index FROM artifacts WHERE artifact_id = ?",
            arrayOf(artifactId),
        )
        row.use { cursor ->
            check(cursor.moveToFirst()) { "Unknown artifact $artifactId" }
            val meeting = safePath(cursor.getString(0))
            val kind = safePath(cursor.getString(1))
            val index = if (cursor.isNull(2)) "final" else "segment-${cursor.getInt(2).toString().padStart(4, '0')}"
            return "${safePath(installId())}/$meeting/$kind/$index-${safePath(artifactId)}.$extension"
        }
    }

    private fun scalarLong(sql: String): Long = readableDatabase.rawQuery(sql, null).use { cursor ->
        if (cursor.moveToFirst()) cursor.getLong(0) else 0L
    }

    private fun scalarNullableLong(sql: String): Long? = readableDatabase.rawQuery(sql, null).use { cursor ->
        if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getLong(0) else null
    }

    private fun installId(): String {
        val existing = prefs.getString(KEY_INSTALL_ID, null)
        if (existing != null) return existing
        val created = UUID.randomUUID().toString()
        prefs.edit().putString(KEY_INSTALL_ID, created).apply()
        return created
    }

    private fun JSONObject.addBase(config: DiagnosticConfig) {
        put("install_id", config.installId)
        put("app_session_id", config.appSessionId)
        put("app_version", config.appVersion)
        put("build_number", config.buildNumber)
        put("git_sha", config.gitSha)
        put("device", config.device)
        put("platform", config.platform)
    }

    private fun JSONObject.putNullable(key: String, value: Any?) {
        put(key, toJsonValue(value) ?: JSONObject.NULL)
    }

    private fun Map<String, Any?>.string(key: String): String = this[key]?.toString() ?: ""
    private fun Map<String, Any?>.boolean(key: String): Boolean = this[key] as? Boolean ?: false
    private fun Map<String, Any?>.long(key: String): Long = (this[key] as? Number)?.toLong() ?: 0L
    private fun Map<String, Any?>.int(key: String): Int = (this[key] as? Number)?.toInt() ?: 0

    private fun priorityFor(level: String): Int = when (level) {
        "error" -> 3
        "warn" -> 2
        else -> 1
    }

    companion object {
        private const val DB_NAME = "maina-diagnostics.db"
        private const val DB_VERSION = 2
        private const val PREFS_NAME = "maina_diagnostics_config"
        private const val KEY_INSTALL_ID = "install_id"
        private const val KEY_ENABLED = "enabled"
        private const val KEY_URL = "url"
        private const val KEY_API_KEY = "api_key"
        private const val KEY_BUCKET = "bucket"
        private const val KEY_APP_SESSION_ID = "app_session_id"
        private const val KEY_APP_VERSION = "app_version"
        private const val KEY_BUILD_NUMBER = "build_number"
        private const val KEY_GIT_SHA = "git_sha"
        private const val KEY_DEVICE = "device"
        private const val KEY_PLATFORM = "platform"
        private const val KEY_RETENTION_DAYS = "retention_days"
        private const val KEY_LAST_UPLOAD_AT = "last_upload_at"
        private const val KEY_LAST_ERROR = "last_error"
        private const val DAY_MS = 24L * 60L * 60L * 1000L

        private fun uriToPath(uri: String): String = when {
            uri.startsWith("file://") -> runCatching { File(URI(uri)).absolutePath }.getOrDefault(uri.removePrefix("file://"))
            else -> uri
        }

        private fun safePath(value: String): String = value.replace(Regex("[^A-Za-z0-9._-]"), "-")

        private fun isoTime(epochMs: Long): String = java.time.Instant.ofEpochMilli(epochMs).toString()

        private fun toJsonValue(value: Any?): Any? = when (value) {
            null -> null
            is JSONObject, is JSONArray, is String, is Number, is Boolean -> value
            is Map<*, *> -> JSONObject().apply {
                value.forEach { (key, item) -> if (key != null) put(key.toString(), toJsonValue(item) ?: JSONObject.NULL) }
            }
            is Iterable<*> -> JSONArray().apply { value.forEach { put(toJsonValue(it) ?: JSONObject.NULL) } }
            is Array<*> -> JSONArray().apply { value.forEach { put(toJsonValue(it) ?: JSONObject.NULL) } }
            else -> value.toString()
        }
    }
}
