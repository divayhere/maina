package com.divay.maina.recorder

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
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
    val meetingId: String?,
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
    val attempts: Int,
    val lastError: String?,
)

internal object MainaDiagnosticsPrivacySchema {
    const val ADD_OUTBOX_MEETING_ID = "ALTER TABLE outbox_records ADD COLUMN meeting_id TEXT"
    const val ADD_OUTBOX_PRIVACY_SCOPE =
        "ALTER TABLE outbox_records ADD COLUMN privacy_scope TEXT NOT NULL DEFAULT 'ordinary' CHECK (privacy_scope IN ('ordinary','legacy_unknown'))"
    const val ADD_ARTIFACT_PRIVACY_SCOPE =
        "ALTER TABLE artifacts ADD COLUMN privacy_scope TEXT NOT NULL DEFAULT 'ordinary' CHECK (privacy_scope IN ('ordinary','legacy_unknown'))"
    const val CREATE_POLICY = """CREATE TABLE IF NOT EXISTS diagnostics_policy (
        singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
        mode TEXT NOT NULL CHECK (mode IN ('ordinary','qualification_reserved','qualification_active','qualification_terminal_ready')),
        qualification_meeting_id TEXT,
        qualification_evidence_digest TEXT,
        generation INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        CHECK ((mode = 'ordinary' AND qualification_meeting_id IS NULL AND qualification_evidence_digest IS NULL)
            OR (mode != 'ordinary' AND qualification_meeting_id IS NOT NULL AND qualification_evidence_digest IS NOT NULL))
    )"""
    const val INSERT_POLICY = """INSERT OR IGNORE INTO diagnostics_policy(
        singleton_id, mode, qualification_meeting_id, qualification_evidence_digest, generation, updated_at
    ) VALUES (1, 'ordinary', NULL, NULL, 0, 0)"""
    const val CREATE_DISCARDED_MEETINGS = """CREATE TABLE IF NOT EXISTS discarded_meetings (
        meeting_id TEXT PRIMARY KEY NOT NULL,
        discarded_at INTEGER NOT NULL
    )"""
}

internal enum class MainaDiagnosticsQualificationPhase(val wireValue: String) {
    ORDINARY("ordinary"),
    RESERVED("qualification_reserved"),
    CAPTURE_ACTIVE("qualification_active"),
    TERMINAL_READY("qualification_terminal_ready"),
}

internal object MainaDiagnosticsQualificationTransitionPolicy {
    fun allowed(
        from: MainaDiagnosticsQualificationPhase,
        to: MainaDiagnosticsQualificationPhase,
    ): Boolean = when (from) {
        MainaDiagnosticsQualificationPhase.ORDINARY -> to == MainaDiagnosticsQualificationPhase.RESERVED
        MainaDiagnosticsQualificationPhase.RESERVED ->
            to == MainaDiagnosticsQualificationPhase.CAPTURE_ACTIVE ||
                to == MainaDiagnosticsQualificationPhase.ORDINARY
        MainaDiagnosticsQualificationPhase.CAPTURE_ACTIVE ->
            to == MainaDiagnosticsQualificationPhase.TERMINAL_READY
        MainaDiagnosticsQualificationPhase.TERMINAL_READY ->
            to == MainaDiagnosticsQualificationPhase.ORDINARY
    }

    fun mayReconcileWithoutCaptureControl(phase: MainaDiagnosticsQualificationPhase): Boolean =
        phase == MainaDiagnosticsQualificationPhase.RESERVED ||
            phase == MainaDiagnosticsQualificationPhase.TERMINAL_READY
}

internal enum class MainaQualificationControlRelation {
    ABSENT,
    MATCHING_ACTIVE,
    MATCHING_TERMINAL,
    OTHER,
    INVALID,
}

internal enum class MainaQualificationRecoveryAction {
    NONE,
    CANCEL_RESERVATION,
    ACTIVATE_CAPTURE,
    RESTORE_CAPTURE,
    PRESERVE_TERMINAL,
    CLEAR_TERMINAL,
    COMPLETE_TERMINAL,
    BLOCK,
}

internal object MainaDiagnosticsQualificationRecoveryPolicy {
    fun action(
        phase: MainaDiagnosticsQualificationPhase,
        control: MainaQualificationControlRelation,
    ): MainaQualificationRecoveryAction = when (phase) {
        MainaDiagnosticsQualificationPhase.ORDINARY -> MainaQualificationRecoveryAction.NONE
        MainaDiagnosticsQualificationPhase.RESERVED -> when (control) {
            MainaQualificationControlRelation.ABSENT -> MainaQualificationRecoveryAction.CANCEL_RESERVATION
            MainaQualificationControlRelation.MATCHING_ACTIVE -> MainaQualificationRecoveryAction.ACTIVATE_CAPTURE
            else -> MainaQualificationRecoveryAction.BLOCK
        }
        MainaDiagnosticsQualificationPhase.CAPTURE_ACTIVE -> when (control) {
            MainaQualificationControlRelation.MATCHING_ACTIVE -> MainaQualificationRecoveryAction.RESTORE_CAPTURE
            MainaQualificationControlRelation.MATCHING_TERMINAL -> MainaQualificationRecoveryAction.PRESERVE_TERMINAL
            else -> MainaQualificationRecoveryAction.BLOCK
        }
        MainaDiagnosticsQualificationPhase.TERMINAL_READY -> when (control) {
            MainaQualificationControlRelation.ABSENT -> MainaQualificationRecoveryAction.COMPLETE_TERMINAL
            MainaQualificationControlRelation.MATCHING_TERMINAL -> MainaQualificationRecoveryAction.CLEAR_TERMINAL
            else -> MainaQualificationRecoveryAction.BLOCK
        }
    }
}

/**
 * A private native outbox. It deliberately does not share the app's SQLite
 * connection: WorkManager can drain this database after React Native is gone.
 */
internal class DiagnosticsStore(context: Context) :
    SQLiteOpenHelper(context.applicationContext, DB_NAME, null, DB_VERSION) {
    private val appContext = context.applicationContext
    private val prefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val deliveryLock = Any()

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
                meeting_id TEXT,
                privacy_scope TEXT NOT NULL DEFAULT 'ordinary'
                    CHECK (privacy_scope IN ('ordinary','legacy_unknown')),
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
                privacy_scope TEXT NOT NULL DEFAULT 'ordinary'
                    CHECK (privacy_scope IN ('ordinary','legacy_unknown')),
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
        createDiagnosticsPolicy(db)
        db.execSQL(MainaDiagnosticsPrivacySchema.CREATE_DISCARDED_MEETINGS)
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        var version = oldVersion
        if (version < 2) {
            db.execSQL("ALTER TABLE outbox_records ADD COLUMN last_attempt_at INTEGER")
            db.execSQL("ALTER TABLE artifacts ADD COLUMN last_attempt_at INTEGER")
            version = 2
        }
        if (version < 3) {
            // v3 changes retention and queue ordering in code only. Bumping the
            // version records the behavioural migration for field diagnostics.
            version = 3
        }
        if (version < 4) {
            // v0.10 wrote native File.toURI() values such as file:/data/... as
            // literal paths. Repair those queued artifacts in place so they
            // can be retried; file:/// values were already normalised by v3.
            db.execSQL(
                """UPDATE artifacts
                   SET source_path = substr(source_path, 6),
                       status = 'pending',
                       attempts = 0,
                       last_error = NULL,
                       last_attempt_at = NULL
                   WHERE source_path LIKE 'file:/%'
                     AND source_path NOT LIKE 'file://%'""",
            )
            version = 4
        }
        if (version < 5) {
            // Qualification capture did not exist in any v4 build, so every
            // pre-v5 diagnostics row has exact ordinary provenance. Preserve
            // pending delivery and retention rather than stranding that data.
            db.execSQL(MainaDiagnosticsPrivacySchema.ADD_OUTBOX_MEETING_ID)
            db.execSQL(MainaDiagnosticsPrivacySchema.ADD_OUTBOX_PRIVACY_SCOPE)
            db.execSQL(MainaDiagnosticsPrivacySchema.ADD_ARTIFACT_PRIVACY_SCOPE)
            createDiagnosticsPolicy(db)
            version = 5
        }
        if (version < 6) {
            db.execSQL(MainaDiagnosticsPrivacySchema.CREATE_DISCARDED_MEETINGS)
            version = 6
        }
        check(version == newVersion) {
            "Unsupported diagnostics database migration $oldVersion -> $newVersion"
        }
    }

    private fun createDiagnosticsPolicy(db: SQLiteDatabase) {
        db.execSQL(MainaDiagnosticsPrivacySchema.CREATE_POLICY)
        db.execSQL(MainaDiagnosticsPrivacySchema.INSERT_POLICY)
    }

    /**
     * Establish the native privacy owner before a qualification meeting or
     * diagnostic payload is created. The same process lock also fences every
     * worker network request, so activation either precedes the request or
     * waits for an already-started ordinary request to finish.
     */
    fun beginQualificationSession(meetingId: String, evidenceDigest: String): Boolean = synchronized(deliveryLock) {
        if (!QUALIFICATION_MEETING_ID.matches(meetingId) || !EVIDENCE_DIGEST.matches(evidenceDigest)) {
            return@synchronized false
        }
        val db = writableDatabase
        var accepted = false
        db.beginTransaction()
        try {
            val current = qualificationPolicy(db)
            accepted = when {
                current.phase == MainaDiagnosticsQualificationPhase.RESERVED ->
                    current.meetingId == meetingId && current.evidenceDigest == evidenceDigest
                current.phase != MainaDiagnosticsQualificationPhase.ORDINARY -> false
                else -> {
                    val values = ContentValues().apply {
                        put("mode", MainaDiagnosticsQualificationPhase.RESERVED.wireValue)
                        put("qualification_meeting_id", meetingId)
                        put("qualification_evidence_digest", evidenceDigest)
                        put("generation", current.generation + 1L)
                        put("updated_at", System.currentTimeMillis())
                    }
                    db.update("diagnostics_policy", values, "singleton_id = 1 AND mode = 'ordinary'", null) == 1
                }
            }
            if (accepted) db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        accepted
    }

    fun qualificationReservationMatches(meetingId: String, evidenceDigest: String): Boolean = synchronized(deliveryLock) {
        val current = qualificationPolicy(readableDatabase)
        current.phase == MainaDiagnosticsQualificationPhase.RESERVED &&
            current.meetingId == meetingId && current.evidenceDigest == evidenceDigest
    }

    fun isQualificationSessionActive(): Boolean = synchronized(deliveryLock) {
        qualificationPolicy(readableDatabase).phase != MainaDiagnosticsQualificationPhase.ORDINARY
    }

    /**
     * Reconcile only crash windows whose exact absence is conclusive: a
     * reservation before native control was persisted, or a terminal handoff
     * after its exact control was cleared. ACTIVE without control is ambiguous
     * and remains fail-closed for explicit recovery.
     */
    fun reconcileAbsentCaptureControl(): Boolean = synchronized(deliveryLock) {
        val current = qualificationPolicy(readableDatabase)
        if (current.phase == MainaDiagnosticsQualificationPhase.ORDINARY) return@synchronized true
        if (!MainaDiagnosticsQualificationTransitionPolicy.mayReconcileWithoutCaptureControl(current.phase)) {
            return@synchronized false
        }
        finishQualificationSessionLocked(
            requireNotNull(current.meetingId),
            requireNotNull(current.evidenceDigest),
            current.phase,
        )
    }

    fun activateQualificationSession(meetingId: String, evidenceDigest: String): Boolean =
        transitionQualificationSession(
            meetingId,
            evidenceDigest,
            MainaDiagnosticsQualificationPhase.RESERVED,
            MainaDiagnosticsQualificationPhase.CAPTURE_ACTIVE,
        )

    fun markQualificationTerminalReady(meetingId: String, evidenceDigest: String): Boolean =
        transitionQualificationSession(
            meetingId,
            evidenceDigest,
            MainaDiagnosticsQualificationPhase.CAPTURE_ACTIVE,
            MainaDiagnosticsQualificationPhase.TERMINAL_READY,
        )

    fun cancelQualificationReservation(meetingId: String, evidenceDigest: String): Boolean =
        finishQualificationSession(
            meetingId,
            evidenceDigest,
            MainaDiagnosticsQualificationPhase.RESERVED,
        )

    fun completeQualificationTerminal(meetingId: String, evidenceDigest: String): Boolean =
        finishQualificationSession(
            meetingId,
            evidenceDigest,
            MainaDiagnosticsQualificationPhase.TERMINAL_READY,
        )

    fun qualificationPhase(meetingId: String, evidenceDigest: String): MainaDiagnosticsQualificationPhase? =
        synchronized(deliveryLock) {
            qualificationPolicy(readableDatabase).takeIf {
                it.meetingId == meetingId && it.evidenceDigest == evidenceDigest
            }?.phase
        }

    fun qualificationRecoveryAction(
        inspection: MainaCaptureControlInspection,
    ): MainaQualificationRecoveryAction = synchronized(deliveryLock) {
        val current = qualificationPolicy(readableDatabase)
        val relation = when (inspection) {
            MainaCaptureControlInspection.Absent -> MainaQualificationControlRelation.ABSENT
            MainaCaptureControlInspection.Invalid -> MainaQualificationControlRelation.INVALID
            is MainaCaptureControlInspection.Quarantined -> MainaQualificationControlRelation.OTHER
            is MainaCaptureControlInspection.Active -> if (
                inspection.control.qualificationSession &&
                inspection.control.meetingId == current.meetingId &&
                inspection.control.qualificationEvidenceDigest == current.evidenceDigest
            ) MainaQualificationControlRelation.MATCHING_ACTIVE else MainaQualificationControlRelation.OTHER
            is MainaCaptureControlInspection.Terminal -> if (
                inspection.control.qualificationSession &&
                inspection.control.meetingId == current.meetingId &&
                inspection.control.qualificationEvidenceDigest == current.evidenceDigest
            ) MainaQualificationControlRelation.MATCHING_TERMINAL else MainaQualificationControlRelation.OTHER
        }
        MainaDiagnosticsQualificationRecoveryPolicy.action(current.phase, relation)
    }

    private fun transitionQualificationSession(
        meetingId: String,
        evidenceDigest: String,
        from: MainaDiagnosticsQualificationPhase,
        to: MainaDiagnosticsQualificationPhase,
    ): Boolean = synchronized(deliveryLock) {
        if (!QUALIFICATION_MEETING_ID.matches(meetingId) || !EVIDENCE_DIGEST.matches(evidenceDigest)) {
            return@synchronized false
        }
        if (!MainaDiagnosticsQualificationTransitionPolicy.allowed(from, to)) return@synchronized false
        val current = qualificationPolicy(readableDatabase)
        if (current.phase == to && current.meetingId == meetingId && current.evidenceDigest == evidenceDigest) {
            return@synchronized true
        }
        val values = ContentValues().apply {
            put("mode", to.wireValue)
            put("updated_at", System.currentTimeMillis())
        }
        writableDatabase.update(
            "diagnostics_policy",
            values,
            "singleton_id = 1 AND mode = ? AND qualification_meeting_id = ? AND qualification_evidence_digest = ?",
            arrayOf(from.wireValue, meetingId, evidenceDigest),
        ) == 1
    }

    private fun finishQualificationSession(
        meetingId: String,
        evidenceDigest: String,
        from: MainaDiagnosticsQualificationPhase,
    ): Boolean = synchronized(deliveryLock) {
        if (!QUALIFICATION_MEETING_ID.matches(meetingId) || !EVIDENCE_DIGEST.matches(evidenceDigest)) {
            return@synchronized false
        }
        if (!MainaDiagnosticsQualificationTransitionPolicy.allowed(
                from,
                MainaDiagnosticsQualificationPhase.ORDINARY,
            )
        ) return@synchronized false
        finishQualificationSessionLocked(meetingId, evidenceDigest, from)
    }

    private fun finishQualificationSessionLocked(
        meetingId: String,
        evidenceDigest: String,
        from: MainaDiagnosticsQualificationPhase,
    ): Boolean {
        val values = ContentValues().apply {
            put("mode", MainaDiagnosticsQualificationPhase.ORDINARY.wireValue)
            putNull("qualification_meeting_id")
            putNull("qualification_evidence_digest")
            put("updated_at", System.currentTimeMillis())
        }
        return writableDatabase.update(
            "diagnostics_policy",
            values,
            "singleton_id = 1 AND mode = ? AND qualification_meeting_id = ? AND qualification_evidence_digest = ?",
            arrayOf(from.wireValue, meetingId, evidenceDigest),
        ) == 1
    }

    fun <T> withOrdinaryDelivery(block: () -> T): T? = synchronized(deliveryLock) {
        if (qualificationPolicy(readableDatabase).phase != MainaDiagnosticsQualificationPhase.ORDINARY) return@synchronized null
        block()
    }

    private data class QualificationPolicy(
        val phase: MainaDiagnosticsQualificationPhase,
        val meetingId: String?,
        val evidenceDigest: String?,
        val generation: Long,
    )

    private fun qualificationPolicy(db: SQLiteDatabase): QualificationPolicy = db.rawQuery(
        "SELECT mode, qualification_meeting_id, qualification_evidence_digest, generation FROM diagnostics_policy WHERE singleton_id = 1",
        null,
    ).use { cursor ->
        check(cursor.moveToFirst() && cursor.count == 1) { "Diagnostics privacy policy is unavailable" }
        QualificationPolicy(
            phase = MainaDiagnosticsQualificationPhase.entries.firstOrNull { it.wireValue == cursor.getString(0) }
                ?: error("Diagnostics privacy policy is invalid"),
            meetingId = if (cursor.isNull(1)) null else cursor.getString(1),
            evidenceDigest = if (cursor.isNull(2)) null else cursor.getString(2),
            generation = cursor.getLong(3),
        )
    }

    private fun ordinaryIngressAllowed(db: SQLiteDatabase): Boolean =
        qualificationPolicy(db).phase == MainaDiagnosticsQualificationPhase.ORDINARY

    fun configure(raw: Map<String, Any?>) {
        val installId = prefs.getString(KEY_INSTALL_ID, null) ?: UUID.randomUUID().toString()
        val packageInfo = appContext.packageManager.getPackageInfo(appContext.packageName, 0)
        val nativeVersion = packageInfo.versionName.orEmpty().ifBlank { "?" }
        val nativeBuild = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
            packageInfo.longVersionCode.toString()
        } else {
            @Suppress("DEPRECATION")
            packageInfo.versionCode.toString()
        }
        prefs.edit()
            .putString(KEY_INSTALL_ID, installId)
            .putBoolean(KEY_ENABLED, raw.boolean("enabled"))
            .putString(KEY_URL, raw.string("supabaseUrl").trimEnd('/'))
            .putString(KEY_API_KEY, raw.string("publishableKey"))
            .putString(KEY_BUCKET, raw.string("bucket"))
            .putString(KEY_APP_SESSION_ID, raw.string("appSessionId"))
            .putString(KEY_APP_VERSION, raw.string("appVersion").takeUnless { it.isBlank() || it == "?" } ?: nativeVersion)
            .putString(KEY_BUILD_NUMBER, raw.string("buildNumber").takeUnless { it.isBlank() || it == "?" } ?: nativeBuild)
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
            if (ordinaryIngressAllowed(writableDatabase)) {
                events.forEach { event ->
                    val eventId = event.string("eventId")
                    if (eventId.isBlank()) return@forEach
                    val meetingId = event.string("meetingId").takeIf(String::isNotBlank)
                    if (meetingId != null && isMeetingDiscarded(writableDatabase, meetingId)) return@forEach
                    val payload = JSONObject().apply {
                        put("event_id", eventId)
                        put("occurred_at", event.string("occurredAt"))
                        put("elapsed_ms", event.long("elapsedMs"))
                        put("sequence", event.long("sequence"))
                        put("level", event.string("level"))
                        put("category", event.string("category"))
                        put("event_name", event.string("eventName"))
                        put("message", event.string("message"))
                        putNullable("meeting_id", meetingId)
                        putNullable("recording_session_id", event["recordingSessionId"])
                        putNullable("segment_index", event["segmentIndex"])
                        putNullable("duration_ms", event["durationMs"])
                        put("payload", toJsonValue(event["payload"]) ?: JSONObject())
                        addBase(config)
                    }
                    if (insertOutbox(
                            "diagnostic_events",
                            eventId,
                            payload,
                            priorityFor(event.string("level")),
                            meetingId,
                        )
                    ) {
                        inserted += 1
                    }
                }
            }
            writableDatabase.setTransactionSuccessful()
        } finally {
            writableDatabase.endTransaction()
        }
        return inserted
    }

    fun queueAudioArtifact(artifactId: String, raw: Map<String, Any?>) {
        val source = mainaFileFromUriOrPath(raw.string("sourceUri")).absolutePath
        require(source.isNotBlank()) { "Audio artifact source is missing" }
        val meetingId = raw.string("meetingId")
        require(meetingId.isNotBlank()) { "Audio artifact meeting id is missing" }
        val values = ContentValues().apply {
            put("artifact_id", artifactId)
            put("meeting_id", meetingId)
            put("privacy_scope", "ordinary")
            put("segment_index", raw.int("segmentIndex"))
            put("kind", "audio")
            put("source_path", source)
            put("duration_ms", raw.long("durationMs"))
            put("status", "pending")
            put("created_at", System.currentTimeMillis())
        }
        writableDatabase.beginTransaction()
        try {
            if (ordinaryIngressAllowed(writableDatabase) && !isMeetingDiscarded(writableDatabase, meetingId)) {
                writableDatabase.insertWithOnConflict("artifacts", null, values, SQLiteDatabase.CONFLICT_IGNORE)
            }
            writableDatabase.setTransactionSuccessful()
        } finally {
            writableDatabase.endTransaction()
        }
    }

    fun queueTextArtifact(artifactId: String, raw: Map<String, Any?>) {
        val meetingId = raw.string("meetingId")
        val kind = raw.string("kind").ifBlank { "transcript" }
        require(meetingId.isNotBlank()) { "Text artifact meeting id is missing" }
        writableDatabase.beginTransaction()
        try {
            if (ordinaryIngressAllowed(writableDatabase) && !isMeetingDiscarded(writableDatabase, meetingId)) {
                val dir = File(appContext.filesDir, "maina-diagnostics-artifacts").apply { mkdirs() }
                val source = File(dir, "$artifactId.txt")
                source.writeText(raw.string("content"), Charsets.UTF_8)
                val values = ContentValues().apply {
                    put("artifact_id", artifactId)
                    put("meeting_id", meetingId)
                    put("privacy_scope", "ordinary")
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
            writableDatabase.setTransactionSuccessful()
        } finally {
            writableDatabase.endTransaction()
        }
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
            if (ordinaryIngressAllowed(writableDatabase) && !isMeetingDiscarded(writableDatabase, meetingId)) {
                writableDatabase.execSQL(
                    "INSERT OR REPLACE INTO finalized_runs(meeting_id, finalized_at) VALUES (?, ?)",
                    arrayOf<Any>(meetingId, System.currentTimeMillis()),
                )
                insertOutbox("diagnostic_runs", runId, payload, 2, meetingId)
            }
            writableDatabase.setTransactionSuccessful()
        } finally {
            writableDatabase.endTransaction()
        }
    }

    fun nextOutbox(targetTable: String, limit: Int): List<OutboxRecord> {
        val result = mutableListOf<OutboxRecord>()
        readableDatabase.query(
            "outbox_records",
            arrayOf("record_id", "target_table", "payload", "meeting_id"),
            "target_table = ? AND privacy_scope = 'ordinary'",
            arrayOf(targetTable),
            null,
            null,
            "priority DESC, created_at ASC",
            limit.toString(),
        ).use { cursor ->
            while (cursor.moveToNext()) {
                result += OutboxRecord(
                    cursor.getString(0),
                    cursor.getString(1),
                    cursor.getString(2),
                    if (cursor.isNull(3)) null else cursor.getString(3),
                )
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
                arrayOf<Any>(error.take(1000), System.currentTimeMillis(), id),
            )
        }
        setLastError(error)
    }

    fun pendingArtifacts(limit: Int = 16): List<ArtifactRecord> = queryArtifacts(
        "privacy_scope = 'ordinary' AND status IN ('pending', 'prepared', 'failed') AND attempts < 8",
        emptyArray(),
        "CASE WHEN kind = 'audio' THEN 1 ELSE 0 END ASC, created_at ASC",
        limit,
    )

    fun expiredArtifacts(now: Long, limit: Int = 20): List<ArtifactRecord> = queryArtifacts(
        "privacy_scope = 'ordinary' AND status = 'uploaded' AND remote_deleted = 0 AND expires_at IS NOT NULL AND expires_at <= ?",
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
        val changed = writableDatabase.update(
            "artifacts",
            values,
            "privacy_scope = 'ordinary' AND status = 'failed'",
            null,
        )
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
            insertOutbox("diagnostic_artifacts", artifact.artifactId, remote, 2, artifact.meetingId)
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
            arrayOf<Any>(error.take(1000), System.currentTimeMillis(), artifactId),
        )
        setLastError(error)
    }

    fun markRemoteDeleted(artifactId: String) {
        writableDatabase.execSQL(
            "UPDATE artifacts SET remote_deleted = 1 WHERE artifact_id = ?",
            arrayOf(artifactId),
        )
    }

    /**
     * Keep recoverable audio for seven days, then evict oldest completed audio
     * on a 3 GiB rolling cap or when the phone has less than 5 GiB free. Active,
     * failed, incomplete and unsynced meetings are never eligible.
     */
    fun cleanupRetainedLocalSources(
        now: Long = System.currentTimeMillis(),
        assertAllowed: () -> Unit = {},
    ): List<String> {
        assertAllowed()
        val safeMeetings = mutableSetOf<String>()
        readableDatabase.rawQuery(
            """SELECT fr.meeting_id
               FROM finalized_runs fr
               WHERE EXISTS (
                 SELECT 1 FROM artifacts t
                 WHERE t.meeting_id = fr.meeting_id
                   AND t.privacy_scope = 'ordinary'
                   AND t.kind = 'transcript' AND t.status = 'uploaded'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM artifacts a
                 WHERE a.meeting_id = fr.meeting_id
                   AND a.privacy_scope = 'ordinary'
                   AND a.status != 'uploaded'
               )""",
            null,
        ).use { cursor -> while (cursor.moveToNext()) safeMeetings += cursor.getString(0) }

        val candidates = queryArtifacts(
            "privacy_scope = 'ordinary' AND kind = 'audio' AND status = 'uploaded' AND source_deleted = 0",
            emptyArray(),
            "created_at ASC",
            10_000,
        ).filter { it.meetingId in safeMeetings }
        var retainedBytes = candidates.sumOf { artifact ->
            assertAllowed()
            localBytes(artifact)
        }
        val deletedMeetings = mutableSetOf<String>()
        candidates.forEach { artifact ->
            assertAllowed()
            val expired = artifact.expiresAt?.let { it <= now } ?: false
            val overCap = retainedBytes > LOCAL_AUDIO_CAP_BYTES
            val storageLow = appContext.filesDir.usableSpace in 1 until MIN_FREE_STORAGE_BYTES
            if (!expired && !overCap && !storageLow) return@forEach
            assertAllowed()
            val bytes = localBytes(artifact)
            assertAllowed()
            if (deleteLocalFiles(artifact)) {
                retainedBytes = (retainedBytes - bytes).coerceAtLeast(0L)
                deletedMeetings += artifact.meetingId
            }
        }
        return deletedMeetings.toList()
    }

    fun meetingsWithDeletedAudio(): List<String> {
        val result = mutableListOf<String>()
        readableDatabase.rawQuery(
            """SELECT meeting_id FROM artifacts
               WHERE privacy_scope = 'ordinary' AND kind = 'audio'
               GROUP BY meeting_id
               HAVING COUNT(*) > 0 AND SUM(CASE WHEN source_deleted = 1 THEN 1 ELSE 0 END) = COUNT(*)""",
            null,
        ).use { cursor -> while (cursor.moveToNext()) result += cursor.getString(0) }
        return result
    }

    fun status(): Map<String, Any> {
        val pendingEvents = scalarLong("SELECT COUNT(*) FROM outbox_records WHERE privacy_scope = 'ordinary'").toInt()
        val pendingArtifacts = scalarLong("SELECT COUNT(*) FROM artifacts WHERE privacy_scope = 'ordinary' AND status IN ('pending','prepared')").toInt()
        val failedArtifacts = scalarLong("SELECT COUNT(*) FROM artifacts WHERE privacy_scope = 'ordinary' AND status = 'failed'").toInt()
        val exhaustedArtifacts = scalarLong("SELECT COUNT(*) FROM artifacts WHERE privacy_scope = 'ordinary' AND status = 'failed' AND attempts >= 8").toInt()
        val retainedAudioBytes = scalarLong(
            "SELECT COALESCE(SUM(bytes), 0) FROM artifacts WHERE privacy_scope = 'ordinary' AND kind = 'audio' AND source_deleted = 0",
        )
        val oldestPendingAt = scalarNullableLong(
            """SELECT MIN(created_at) FROM (
                 SELECT created_at FROM outbox_records WHERE privacy_scope = 'ordinary'
                 UNION ALL
                 SELECT created_at FROM artifacts WHERE privacy_scope = 'ordinary' AND status IN ('pending','prepared','failed')
               )""",
        )
        val lastAttemptAt = scalarNullableLong(
            """SELECT MAX(last_attempt_at) FROM (
                 SELECT last_attempt_at FROM outbox_records WHERE privacy_scope = 'ordinary'
                 UNION ALL
                 SELECT last_attempt_at FROM artifacts WHERE privacy_scope = 'ordinary'
               )""",
        )
        return mutableMapOf<String, Any>(
            "enabled" to config().enabled,
            "installId" to installId(),
            "pendingEvents" to pendingEvents,
            "pendingArtifacts" to pendingArtifacts,
            "failedArtifacts" to failedArtifacts,
            "exhaustedArtifacts" to exhaustedArtifacts,
            "retainedAudioBytes" to retainedAudioBytes,
            "freeStorageBytes" to appContext.filesDir.usableSpace,
        ).apply {
            oldestPendingAt?.let { put("oldestPendingAt", it) }
            lastAttemptAt?.let { put("lastAttemptAt", it) }
            prefs.getLong(KEY_LAST_UPLOAD_AT, 0L).takeIf { it > 0L }?.let { put("lastUploadAt", it) }
            prefs.getString(KEY_LAST_ERROR, null)?.let { put("lastError", it) }
        }
    }

    fun purgeAllDiagnosticsData(): Map<String, Any> {
        val artifacts = queryArtifacts("1 = 1", emptyArray(), "created_at ASC", 100_000)
        val deletedOutboxRecords = scalarLong("SELECT COUNT(*) FROM outbox_records").toInt()
        var deletedFiles = 0
        artifacts.forEach { artifact ->
            if (deleteLocalFiles(artifact)) deletedFiles += 1
        }
        writableDatabase.beginTransaction()
        try {
            writableDatabase.delete("outbox_records", null, null)
            writableDatabase.delete("artifacts", null, null)
            writableDatabase.delete("finalized_runs", null, null)
            writableDatabase.setTransactionSuccessful()
        } finally {
            writableDatabase.endTransaction()
        }
        prefs.edit()
            .remove(KEY_LAST_ERROR)
            .remove(KEY_LAST_UPLOAD_AT)
            .apply()
        return mapOf(
            "deletedArtifacts" to artifacts.size,
            "deletedOutboxRecords" to deletedOutboxRecords,
            "deletedFiles" to deletedFiles,
        )
    }

    /**
     * Removes every local diagnostic representation of one user-discarded
     * meeting before capture authority can be cleared. A failed file deletion
     * keeps the terminal DISCARD owner durable, so no worker can upload a
     * surviving prepared copy.
     */
    fun purgeMeetingDiagnostics(meetingId: String): Boolean = synchronized(deliveryLock) {
        if (!Regex("^[A-Za-z0-9._:-]{1,128}$").matches(meetingId)) return@synchronized false
        writableDatabase.beginTransaction()
        return@synchronized try {
            val expected = writableDatabase.rawQuery(
                "SELECT COUNT(*) FROM artifacts WHERE meeting_id = ?",
                arrayOf(meetingId),
            ).use { cursor -> if (cursor.moveToFirst()) cursor.getLong(0) else 0L }
            if (expected > 100_000L) return@synchronized false
            val artifacts = queryArtifacts(
                "meeting_id = ?",
                arrayOf(meetingId),
                "created_at ASC",
                100_000,
            )
            if (artifacts.size.toLong() != expected) return@synchronized false
            var filesRemoved = true
            artifacts.forEach { artifact ->
                if (!deleteLocalFiles(artifact)) filesRemoved = false
            }
            if (!filesRemoved) return@synchronized false
            writableDatabase.execSQL(
                "INSERT OR IGNORE INTO discarded_meetings(meeting_id, discarded_at) VALUES (?, ?)",
                arrayOf<Any>(meetingId, System.currentTimeMillis()),
            )
            writableDatabase.delete("outbox_records", "meeting_id = ?", arrayOf(meetingId))
            writableDatabase.delete("artifacts", "meeting_id = ?", arrayOf(meetingId))
            writableDatabase.delete("finalized_runs", "meeting_id = ?", arrayOf(meetingId))
            writableDatabase.setTransactionSuccessful()
            true
        } finally {
            writableDatabase.endTransaction()
        }
    }

    fun isMeetingDiscarded(meetingId: String): Boolean = isMeetingDiscarded(readableDatabase, meetingId)

    private fun isMeetingDiscarded(db: SQLiteDatabase, meetingId: String): Boolean = db.rawQuery(
        "SELECT 1 FROM discarded_meetings WHERE meeting_id = ? LIMIT 1",
        arrayOf(meetingId),
    ).use { cursor -> cursor.moveToFirst() }

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

    private fun insertOutbox(
        target: String,
        id: String,
        payload: JSONObject,
        priority: Int,
        meetingId: String?,
    ): Boolean {
        if (meetingId != null && isMeetingDiscarded(writableDatabase, meetingId)) return false
        val values = ContentValues().apply {
            put("record_id", id)
            put("target_table", target)
            put("payload", payload.toString())
            put("meeting_id", meetingId)
            put("privacy_scope", "ordinary")
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
                "bytes", "sha256", "status", "expires_at", "attempts", "last_error",
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
                    attempts = cursor.getInt(14),
                    lastError = if (cursor.isNull(15)) null else cursor.getString(15),
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

    private fun localBytes(artifact: ArtifactRecord): Long {
        val paths = listOfNotNull(artifact.sourcePath, artifact.preparedPath).distinct()
        return paths.sumOf { path -> mainaFileFromUriOrPath(path).takeIf(File::isFile)?.length() ?: 0L }
    }

    private fun deleteLocalFiles(artifact: ArtifactRecord): Boolean {
        val files = listOfNotNull(artifact.sourcePath, artifact.preparedPath)
            .distinct()
            .map(::mainaFileFromUriOrPath)
        var removed = true
        files.forEach { file ->
            if (file.exists() && !runCatching { file.delete() }.getOrDefault(false)) removed = false
        }
        if (removed) {
            writableDatabase.execSQL(
                "UPDATE artifacts SET source_deleted = 1 WHERE artifact_id = ?",
                arrayOf(artifact.artifactId),
            )
        } else {
            setLastError("Could not delete retained audio for artifact ${artifact.artifactId}")
        }
        return removed
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
        @Volatile
        private var instance: DiagnosticsStore? = null

        /** One process-wide helper avoids repeated WAL open/close contention. */
        fun shared(context: Context): DiagnosticsStore = instance ?: synchronized(this) {
            instance ?: DiagnosticsStore(context.applicationContext).also { instance = it }
        }

        private const val DB_NAME = "maina-diagnostics.db"
        private const val DB_VERSION = 6
        private val QUALIFICATION_MEETING_ID = Regex("^[A-Za-z0-9._:-]{1,128}$")
        private val EVIDENCE_DIGEST = Regex("^[0-9a-f]{64}$")
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
        private const val LOCAL_AUDIO_CAP_BYTES = 3L * 1024L * 1024L * 1024L
        private const val MIN_FREE_STORAGE_BYTES = 5L * 1024L * 1024L * 1024L

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
