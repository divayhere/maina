package com.divay.maina.recorder

import android.content.Context
import java.io.File
import java.net.URI

/**
 * One small durable authority for native capture control ownership. Audio and
 * chunks remain in the existing capture directory; this stores only the
 * active meeting pointer and reducer state needed to fail closed after the
 * service process is recreated.
 */
internal data class MainaDurableCaptureControl(
    val meetingId: String,
    val directory: String,
    val sourceMode: String,
    val chunkDurationMs: Long,
    val meetingStartedAt: Long,
    val qualificationSession: Boolean,
    val qualificationEvidenceDigest: String?,
    val phase: MainaCaptureControlPhase,
    val terminalDisposition: MainaCaptureTerminalDisposition?,
    val terminalDiscardId: String?,
    val terminalEffectReady: Boolean,
    val pauseOwner: MainaCapturePauseOwner,
    val generation: Long,
    val communicationActive: Boolean,
    val chunkSequence: Int,
    val captureGapMs: Long,
    val updatedAtEpochMs: Long,
    val sourceFormatVersion: Int = CURRENT_SOURCE_FORMAT_VERSION,
    val quarantineReason: MainaCaptureQuarantineReason? = null,
) {
    fun reducerState(): MainaCaptureControlState = MainaCaptureControlState(
        phase = phase,
        pauseOwner = pauseOwner,
        generation = generation,
        communicationActive = communicationActive,
    )
}

internal const val CURRENT_SOURCE_FORMAT_VERSION = 2

internal enum class MainaCaptureQuarantineReason {
    LEGACY_TERMINAL_DISPOSITION_MISSING,
}

internal enum class MainaCaptureTerminalDisposition {
    SAVE,
    DISCARD,
}

internal sealed interface MainaDiscardPreparation {
    data class Prepared(val control: MainaDurableCaptureControl) : MainaDiscardPreparation
    data object NoCapture : MainaDiscardPreparation
    data object Blocked : MainaDiscardPreparation
}

internal enum class MainaTerminalRestartAction {
    PRESERVE_FOR_POST_PROCESSING,
    DELETE_CAPTURE,
}

internal object MainaCaptureTerminalRecoveryPolicy {
    fun restartAction(disposition: MainaCaptureTerminalDisposition): MainaTerminalRestartAction =
        when (disposition) {
            MainaCaptureTerminalDisposition.SAVE -> MainaTerminalRestartAction.PRESERVE_FOR_POST_PROCESSING
            MainaCaptureTerminalDisposition.DISCARD -> MainaTerminalRestartAction.DELETE_CAPTURE
        }

    fun dispositionForLifecycleInvalidation(
        phase: MainaCaptureControlPhase,
        existing: MainaCaptureTerminalDisposition?,
    ): MainaCaptureTerminalDisposition? = when {
        existing != null -> existing
        phase == MainaCaptureControlPhase.TERMINAL -> null
        else -> MainaCaptureTerminalDisposition.SAVE
    }
}

internal enum class MainaCaptureControlStorageFormat {
    CURRENT,
    LEGACY_V1,
    INVALID,
}

internal object MainaLegacyTerminalMigrationPolicy {
    fun quarantineReason(
        storageFormat: MainaCaptureControlStorageFormat,
        phase: MainaCaptureControlPhase,
    ): MainaCaptureQuarantineReason? = if (
        storageFormat == MainaCaptureControlStorageFormat.LEGACY_V1 &&
        phase == MainaCaptureControlPhase.TERMINAL
    ) {
        MainaCaptureQuarantineReason.LEGACY_TERMINAL_DISPOSITION_MISSING
    } else {
        null
    }
}

internal object MainaCaptureControlCasPolicy {
    fun allows(observed: MainaDurableCaptureControl, expected: MainaDurableCaptureControl): Boolean =
        observed == expected
}

internal class MainaCaptureWriteAuthority {
    private var uncertain = false

    fun permitsAccess(): Boolean = synchronized(this) { !uncertain }

    fun commit(write: () -> Boolean): Boolean = synchronized(this) {
        if (uncertain) return@synchronized false
        val committed = runCatching(write).getOrDefault(false)
        if (!committed) uncertain = true
        committed
    }
}

internal object MainaCaptureTerminalAuthorityPolicy {
    fun allows(
        phase: MainaCaptureControlPhase,
        disposition: MainaCaptureTerminalDisposition?,
        quarantineReason: MainaCaptureQuarantineReason?,
    ): Boolean =
        (phase == MainaCaptureControlPhase.TERMINAL) ==
            (listOfNotNull(disposition, quarantineReason).size == 1)
}

internal object MainaCaptureDirectoryPolicy {
    private val meetingId = Regex("^[A-Za-z0-9._:-]{1,128}$")

    fun matches(filesDirectory: File, expectedMeetingId: String, directory: String): Boolean = runCatching {
        if (!meetingId.matches(expectedMeetingId) || directory.isBlank() || directory.length > 4096) {
            return@runCatching false
        }
        val candidate = if (directory.startsWith("file:")) File(URI(directory)) else File(directory)
        candidate.canonicalFile == File(filesDirectory.canonicalFile, "rec-$expectedMeetingId").canonicalFile
    }.getOrDefault(false)
}

internal object MainaCaptureControlStoragePolicy {
    private val currentRequiredKeys = setOf(
        "meeting_id",
        "directory",
        "source_mode",
        "chunk_duration_ms",
        "meeting_started_at",
        "qualification_session",
        "phase",
        "pause_owner",
        "generation",
        "communication_active",
        "chunk_sequence",
        "capture_gap_ms",
        "updated_at",
    )
    private val currentOptionalKeys = setOf(
        "qualification_evidence_digest",
        "terminal_disposition",
        "terminal_discard_id",
        "terminal_effect_ready",
        "source_format_version",
        "quarantine_reason",
    )
    private val legacyV1RequiredKeys = currentRequiredKeys - "qualification_session"

    fun classify(stored: Map<String, *>): MainaCaptureControlStorageFormat {
        val keys = stored.keys
        val format = when {
            keys == legacyV1RequiredKeys -> MainaCaptureControlStorageFormat.LEGACY_V1
            keys.containsAll(currentRequiredKeys) &&
                keys.all { it in currentRequiredKeys || it in currentOptionalKeys } ->
                MainaCaptureControlStorageFormat.CURRENT
            else -> MainaCaptureControlStorageFormat.INVALID
        }
        if (format == MainaCaptureControlStorageFormat.INVALID) return format
        val exactBaseTypes = listOf(
            "meeting_id", "directory", "source_mode", "phase", "pause_owner",
        ).all { stored[it] is String } && listOf(
            "chunk_duration_ms", "meeting_started_at", "generation", "capture_gap_ms", "updated_at",
        ).all { stored[it] is Long } && stored["communication_active"] is Boolean &&
            stored["chunk_sequence"] is Int
        if (!exactBaseTypes) return MainaCaptureControlStorageFormat.INVALID
        if (format == MainaCaptureControlStorageFormat.CURRENT &&
            (stored["qualification_session"] !is Boolean ||
                ("qualification_evidence_digest" in stored && stored["qualification_evidence_digest"] !is String) ||
                ("terminal_disposition" in stored && stored["terminal_disposition"] !is String) ||
                ("terminal_discard_id" in stored && stored["terminal_discard_id"] !is String) ||
                ("terminal_effect_ready" in stored && stored["terminal_effect_ready"] !is Boolean) ||
                ("source_format_version" in stored && stored["source_format_version"] !is Int) ||
                ("quarantine_reason" in stored && stored["quarantine_reason"] !is String))
        ) {
            return MainaCaptureControlStorageFormat.INVALID
        }
        return format
    }
}

internal sealed interface MainaCaptureControlInspection {
    data object Absent : MainaCaptureControlInspection
    data object Invalid : MainaCaptureControlInspection
    data class Active(val control: MainaDurableCaptureControl) : MainaCaptureControlInspection
    data class Terminal(val control: MainaDurableCaptureControl) : MainaCaptureControlInspection
    data class Quarantined(val control: MainaDurableCaptureControl) : MainaCaptureControlInspection
}

internal class MainaCaptureControlStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val filesDirectory = context.applicationContext.filesDir.canonicalFile

    fun inspect(): MainaCaptureControlInspection = synchronized(STORE_LOCK) {
        runCatching { inspectUnlocked() }.getOrDefault(MainaCaptureControlInspection.Invalid)
    }

    private fun inspectUnlocked(): MainaCaptureControlInspection {
        if (!WRITE_AUTHORITY.permitsAccess()) return MainaCaptureControlInspection.Invalid
        val stored = prefs.all
        if (stored.isEmpty()) return MainaCaptureControlInspection.Absent
        val storageFormat = MainaCaptureControlStoragePolicy.classify(stored)
        if (storageFormat == MainaCaptureControlStorageFormat.INVALID) {
            return MainaCaptureControlInspection.Invalid
        }
        val meetingId = (stored[KEY_MEETING_ID] as? String)?.takeIf(String::isNotBlank)
            ?: return MainaCaptureControlInspection.Invalid
        val directory = (stored[KEY_DIRECTORY] as? String)?.takeIf(String::isNotBlank)
            ?: return MainaCaptureControlInspection.Invalid
        val phase = enumValueOrNull<MainaCaptureControlPhase>(stored[KEY_PHASE] as? String)
            ?: return MainaCaptureControlInspection.Invalid
        val owner = enumValueOrNull<MainaCapturePauseOwner>(stored[KEY_OWNER] as? String)
            ?: return MainaCaptureControlInspection.Invalid
        val terminalDisposition = if (storageFormat == MainaCaptureControlStorageFormat.LEGACY_V1) {
            null
        } else {
            if (KEY_TERMINAL_DISPOSITION in stored && stored[KEY_TERMINAL_DISPOSITION] !is String) {
                return MainaCaptureControlInspection.Invalid
            }
            enumValueOrNull<MainaCaptureTerminalDisposition>(
                stored[KEY_TERMINAL_DISPOSITION] as? String,
            )
        }
        val legacyQuarantineReason = MainaLegacyTerminalMigrationPolicy.quarantineReason(storageFormat, phase)
        val quarantineReason = legacyQuarantineReason ?: run {
            if (KEY_QUARANTINE_REASON in stored && stored[KEY_QUARANTINE_REASON] !is String) {
                return MainaCaptureControlInspection.Invalid
            }
            enumValueOrNull<MainaCaptureQuarantineReason>(stored[KEY_QUARANTINE_REASON] as? String)
        }
        val sourceFormatVersion = if (quarantineReason != null) {
            stored[KEY_SOURCE_FORMAT_VERSION] as? Int ?: 1
        } else {
            stored[KEY_SOURCE_FORMAT_VERSION] as? Int ?: CURRENT_SOURCE_FORMAT_VERSION
        }
        if (phase == MainaCaptureControlPhase.IDLE) return MainaCaptureControlInspection.Invalid
        if (!MainaCaptureTerminalAuthorityPolicy.allows(phase, terminalDisposition, quarantineReason)) {
            return MainaCaptureControlInspection.Invalid
        }
        val terminalDiscardId = (stored["terminal_discard_id"] as? String)
            ?.takeIf { Regex("^[A-Za-z0-9._:-]{1,128}$").matches(it) }
        if ((terminalDisposition == MainaCaptureTerminalDisposition.DISCARD) != (terminalDiscardId != null)) {
            return MainaCaptureControlInspection.Invalid
        }
        val terminalEffectReady = stored[KEY_TERMINAL_EFFECT_READY] as? Boolean ?: false
        if (terminalEffectReady && (phase != MainaCaptureControlPhase.TERMINAL || quarantineReason != null)) {
            return MainaCaptureControlInspection.Invalid
        }
        val qualificationSession = if (storageFormat == MainaCaptureControlStorageFormat.LEGACY_V1) {
            false
        } else {
            stored[KEY_QUALIFICATION_SESSION] as? Boolean
                ?: return MainaCaptureControlInspection.Invalid
        }
        val qualificationEvidenceDigest = if (storageFormat == MainaCaptureControlStorageFormat.LEGACY_V1) {
            null
        } else {
            if (KEY_QUALIFICATION_EVIDENCE_DIGEST in stored &&
                stored[KEY_QUALIFICATION_EVIDENCE_DIGEST] !is String
            ) {
                return MainaCaptureControlInspection.Invalid
            }
            MainaQualificationSessionPolicy.canonicalEvidenceDigest(
                stored[KEY_QUALIFICATION_EVIDENCE_DIGEST] as? String,
            )
        }
        if (qualificationSession != (qualificationEvidenceDigest != null)) {
            return MainaCaptureControlInspection.Invalid
        }
        val value = MainaDurableCaptureControl(
            meetingId = meetingId,
            directory = directory,
            sourceMode = stored[KEY_SOURCE_MODE] as? String
                ?: return MainaCaptureControlInspection.Invalid,
            chunkDurationMs = stored[KEY_CHUNK_DURATION_MS] as? Long
                ?: return MainaCaptureControlInspection.Invalid,
            meetingStartedAt = stored[KEY_MEETING_STARTED_AT] as? Long
                ?: return MainaCaptureControlInspection.Invalid,
            qualificationSession = qualificationSession,
            qualificationEvidenceDigest = qualificationEvidenceDigest,
            phase = phase,
            terminalDisposition = terminalDisposition,
            terminalDiscardId = terminalDiscardId,
            terminalEffectReady = terminalEffectReady,
            pauseOwner = owner,
            generation = stored[KEY_GENERATION] as? Long
                ?: return MainaCaptureControlInspection.Invalid,
            communicationActive = stored[KEY_COMMUNICATION_ACTIVE] as? Boolean
                ?: return MainaCaptureControlInspection.Invalid,
            chunkSequence = stored[KEY_CHUNK_SEQUENCE] as? Int
                ?: return MainaCaptureControlInspection.Invalid,
            captureGapMs = stored[KEY_CAPTURE_GAP_MS] as? Long
                ?: return MainaCaptureControlInspection.Invalid,
            updatedAtEpochMs = stored[KEY_UPDATED_AT] as? Long
                ?: return MainaCaptureControlInspection.Invalid,
            sourceFormatVersion = sourceFormatVersion,
            quarantineReason = quarantineReason,
        )
        if (!MEETING_ID.matches(value.meetingId) || !captureDirectoryMatchesMeeting(value.meetingId, value.directory) ||
            value.sourceMode !in SOURCE_MODES || value.chunkDurationMs <= 0L ||
            value.meetingStartedAt <= 0L || value.generation < 0L ||
            value.chunkSequence < 0 || value.captureGapMs < 0L || value.updatedAtEpochMs <= 0L ||
            (value.quarantineReason == null && value.sourceFormatVersion != CURRENT_SOURCE_FORMAT_VERSION) ||
            (value.quarantineReason != null && value.sourceFormatVersion != 1)
        ) {
            return MainaCaptureControlInspection.Invalid
        }
        if (storageFormat == MainaCaptureControlStorageFormat.LEGACY_V1) {
            if (!persist(value)) {
                // SharedPreferences updates memory before reporting the disk
                // result. Keep every store instance fail closed for the rest
                // of this process when durability is ambiguous.
                return MainaCaptureControlInspection.Invalid
            }
        }
        return if (quarantineReason != null) {
            MainaCaptureControlInspection.Quarantined(value)
        } else if (phase == MainaCaptureControlPhase.TERMINAL) {
            MainaCaptureControlInspection.Terminal(value)
        } else {
            MainaCaptureControlInspection.Active(value)
        }
    }

    fun read(): MainaDurableCaptureControl? = (inspect() as? MainaCaptureControlInspection.Active)?.control

    fun readIncludingTerminal(): MainaDurableCaptureControl? = when (val inspection = inspect()) {
        is MainaCaptureControlInspection.Active -> inspection.control
        is MainaCaptureControlInspection.Terminal -> inspection.control
        is MainaCaptureControlInspection.Quarantined -> inspection.control
        MainaCaptureControlInspection.Absent,
        MainaCaptureControlInspection.Invalid,
        -> null
    }

    fun begin(
        meetingId: String,
        directory: String,
        sourceMode: String,
        chunkDurationMs: Long,
        meetingStartedAt: Long,
        qualificationSession: Boolean,
        qualificationEvidenceDigest: String?,
        state: MainaCaptureControlState,
    ): Boolean = synchronized(STORE_LOCK) {
        if (inspectUnlocked() != MainaCaptureControlInspection.Absent) return@synchronized false
        persist(
            MainaDurableCaptureControl(
            meetingId = meetingId,
            directory = directory,
            sourceMode = sourceMode,
            chunkDurationMs = chunkDurationMs,
            meetingStartedAt = meetingStartedAt,
            qualificationSession = qualificationSession,
            qualificationEvidenceDigest = qualificationEvidenceDigest,
            phase = state.phase,
            terminalDisposition = null,
            terminalDiscardId = null,
            terminalEffectReady = false,
            pauseOwner = state.pauseOwner,
            generation = state.generation,
            communicationActive = state.communicationActive,
            chunkSequence = 0,
            captureGapMs = 0L,
            updatedAtEpochMs = System.currentTimeMillis(),
            ),
        )
    }

    fun update(
        current: MainaDurableCaptureControl,
        state: MainaCaptureControlState,
        snapshot: MainaNativeAudioCapture.Snapshot,
        terminalDisposition: MainaCaptureTerminalDisposition? = current.terminalDisposition,
        terminalDiscardId: String? = current.terminalDiscardId,
    ): Boolean = synchronized(STORE_LOCK) {
        val observed = when (val inspection = inspectUnlocked()) {
            is MainaCaptureControlInspection.Active -> inspection.control
            is MainaCaptureControlInspection.Terminal -> inspection.control
            is MainaCaptureControlInspection.Quarantined -> return@synchronized false
            MainaCaptureControlInspection.Absent,
            MainaCaptureControlInspection.Invalid,
            -> return@synchronized false
        }
        if (!MainaCaptureControlCasPolicy.allows(observed, current)) return@synchronized false
        persist(
            current.copy(
            phase = state.phase,
            terminalDisposition = terminalDisposition,
            terminalDiscardId = if (terminalDisposition == MainaCaptureTerminalDisposition.DISCARD) {
                terminalDiscardId
            } else {
                null
            },
            terminalEffectReady = if (state.phase == MainaCaptureControlPhase.TERMINAL) {
                current.terminalEffectReady
            } else {
                false
            },
            pauseOwner = state.pauseOwner,
            generation = state.generation,
            communicationActive = state.communicationActive,
            chunkSequence = snapshot.chunkIndex,
            captureGapMs = snapshot.captureGapMs,
            updatedAtEpochMs = System.currentTimeMillis(),
            ),
        )
    }

    fun clear(): Boolean = synchronized(STORE_LOCK) {
        WRITE_AUTHORITY.commit { prefs.edit().clear().commit() }
    }

    /**
     * Synchronously makes a user Discard the durable first terminal owner.
     * The native service may be recreated before its command Intent arrives,
     * so this commit—not service delivery—is the accepted intent boundary.
     */
    fun prepareDiscard(
        meetingId: String,
        discardId: String,
        latchReadsOff: () -> Boolean,
    ): MainaDiscardPreparation = synchronized(STORE_LOCK) {
        if (!MEETING_ID.matches(meetingId) || !DISCARD_ID.matches(discardId)) {
            return@synchronized MainaDiscardPreparation.Blocked
        }
        when (val inspection = runCatching { inspectUnlocked() }.getOrDefault(MainaCaptureControlInspection.Invalid)) {
            MainaCaptureControlInspection.Absent -> MainaDiscardPreparation.NoCapture
            MainaCaptureControlInspection.Invalid -> MainaDiscardPreparation.Blocked
            is MainaCaptureControlInspection.Terminal -> when {
                inspection.control.meetingId != meetingId -> MainaDiscardPreparation.Blocked
                inspection.control.terminalDisposition == MainaCaptureTerminalDisposition.DISCARD &&
                    inspection.control.terminalDiscardId == discardId -> if (latchReadsOff()) {
                        MainaDiscardPreparation.Prepared(inspection.control)
                    } else {
                        MainaDiscardPreparation.Blocked
                    }
                else -> MainaDiscardPreparation.Blocked
            }
            is MainaCaptureControlInspection.Quarantined -> {
                if (inspection.control.meetingId != meetingId ||
                    !captureDirectoryMatchesMeeting(meetingId, inspection.control.directory)
                ) return@synchronized MainaDiscardPreparation.Blocked
                if (!latchReadsOff()) return@synchronized MainaDiscardPreparation.Blocked
                val prepared = inspection.control.copy(
                    phase = MainaCaptureControlPhase.TERMINAL,
                    terminalDisposition = MainaCaptureTerminalDisposition.DISCARD,
                    terminalDiscardId = discardId,
                    terminalEffectReady = false,
                    pauseOwner = MainaCapturePauseOwner.NONE,
                    generation = runCatching { Math.addExact(inspection.control.generation, 1L) }
                        .getOrElse { return@synchronized MainaDiscardPreparation.Blocked },
                    communicationActive = false,
                    updatedAtEpochMs = System.currentTimeMillis(),
                    sourceFormatVersion = CURRENT_SOURCE_FORMAT_VERSION,
                    quarantineReason = null,
                )
                if (persist(prepared)) MainaDiscardPreparation.Prepared(prepared)
                else MainaDiscardPreparation.Blocked
            }
            is MainaCaptureControlInspection.Active -> {
                if (inspection.control.meetingId != meetingId ||
                    !captureDirectoryMatchesMeeting(meetingId, inspection.control.directory)
                ) return@synchronized MainaDiscardPreparation.Blocked
                // This is the microphone-read privacy linearization point. It
                // executes while the store owner is locked, before DISCARD is
                // committed and before JavaScript can begin its SQLite work.
                // Native automatic workers are separately fenced by the
                // terminal owner and durable discarded-meeting tombstones.
                if (!latchReadsOff()) return@synchronized MainaDiscardPreparation.Blocked
                val prepared = inspection.control.copy(
                    phase = MainaCaptureControlPhase.TERMINAL,
                    terminalDisposition = MainaCaptureTerminalDisposition.DISCARD,
                    terminalDiscardId = discardId,
                    terminalEffectReady = false,
                    pauseOwner = MainaCapturePauseOwner.NONE,
                    generation = runCatching { Math.addExact(inspection.control.generation, 1L) }
                        .getOrElse { return@synchronized MainaDiscardPreparation.Blocked },
                    communicationActive = false,
                    updatedAtEpochMs = System.currentTimeMillis(),
                )
                if (persist(prepared)) {
                    MainaDiscardPreparation.Prepared(prepared)
                } else {
                    MainaDiscardPreparation.Blocked
                }
            }
        }
    }

    fun captureDirectoryMatchesMeeting(meetingId: String, directory: String): Boolean =
        MainaCaptureDirectoryPolicy.matches(filesDirectory, meetingId, directory)

    fun recoverQuarantinedAsSave(
        meetingId: String,
        latchReadsOff: () -> Boolean,
    ): MainaDurableCaptureControl? =
        synchronized(STORE_LOCK) {
            val quarantined = (inspectUnlocked() as? MainaCaptureControlInspection.Quarantined)?.control
                ?: return@synchronized null
            if (quarantined.meetingId != meetingId || !captureDirectoryMatchesMeeting(meetingId, quarantined.directory)) {
                return@synchronized null
            }
            if (!latchReadsOff()) return@synchronized null
            val resolved = quarantined.copy(
                terminalDisposition = MainaCaptureTerminalDisposition.SAVE,
                generation = runCatching { Math.addExact(quarantined.generation, 1L) }
                    .getOrElse { return@synchronized null },
                updatedAtEpochMs = System.currentTimeMillis(),
                sourceFormatVersion = CURRENT_SOURCE_FORMAT_VERSION,
                quarantineReason = null,
            )
            if (persist(resolved)) resolved else null
        }

    fun markTerminalEffectReady(expected: MainaDurableCaptureControl): MainaDurableCaptureControl? =
        synchronized(STORE_LOCK) {
            val current = readIncludingTerminal() ?: return@synchronized null
            if (current != expected || current.phase != MainaCaptureControlPhase.TERMINAL) {
                return@synchronized null
            }
            val ready = current.copy(
                terminalEffectReady = true,
                updatedAtEpochMs = System.currentTimeMillis(),
            )
            if (persist(ready)) ready else null
        }

    fun clearIfMatches(expected: MainaDurableCaptureControl): Boolean = synchronized(STORE_LOCK) {
        val current = readIncludingTerminal() ?: return@synchronized false
        if (current != expected) return@synchronized false
        WRITE_AUTHORITY.commit { prefs.edit().clear().commit() }
    }

    private fun persist(value: MainaDurableCaptureControl): Boolean = synchronized(STORE_LOCK) {
        if (value.qualificationSession != (value.qualificationEvidenceDigest != null)) return@synchronized false
        if (!MainaCaptureTerminalAuthorityPolicy.allows(
                value.phase,
                value.terminalDisposition,
                value.quarantineReason,
            )
        ) {
            return@synchronized false
        }
        if ((value.terminalDisposition == MainaCaptureTerminalDisposition.DISCARD) !=
            (value.terminalDiscardId?.matches(DISCARD_ID) == true)
        ) return@synchronized false
        if (value.terminalEffectReady &&
            (value.phase != MainaCaptureControlPhase.TERMINAL || value.quarantineReason != null)
        ) {
            return@synchronized false
        }
        if (!MEETING_ID.matches(value.meetingId) || !captureDirectoryMatchesMeeting(value.meetingId, value.directory) ||
            value.sourceMode !in SOURCE_MODES || value.chunkDurationMs <= 0L || value.meetingStartedAt <= 0L ||
            value.phase == MainaCaptureControlPhase.IDLE || value.generation < 0L ||
            value.chunkSequence < 0 || value.captureGapMs < 0L || value.updatedAtEpochMs <= 0L ||
            (value.quarantineReason == null && value.sourceFormatVersion != CURRENT_SOURCE_FORMAT_VERSION) ||
            (value.quarantineReason != null && value.sourceFormatVersion != 1)
        ) return@synchronized false
        val editor = prefs.edit()
            .putString(KEY_MEETING_ID, value.meetingId)
            .putString(KEY_DIRECTORY, value.directory)
            .putString(KEY_SOURCE_MODE, value.sourceMode)
            .putLong(KEY_CHUNK_DURATION_MS, value.chunkDurationMs)
            .putLong(KEY_MEETING_STARTED_AT, value.meetingStartedAt)
            .putBoolean(KEY_QUALIFICATION_SESSION, value.qualificationSession)
            .putString(KEY_QUALIFICATION_EVIDENCE_DIGEST, value.qualificationEvidenceDigest)
            .putString(KEY_PHASE, value.phase.name)
            .putBoolean(KEY_TERMINAL_EFFECT_READY, value.terminalEffectReady)
            .putString(KEY_OWNER, value.pauseOwner.name)
            .putLong(KEY_GENERATION, value.generation)
            .putBoolean(KEY_COMMUNICATION_ACTIVE, value.communicationActive)
            .putInt(KEY_CHUNK_SEQUENCE, value.chunkSequence)
            .putLong(KEY_CAPTURE_GAP_MS, value.captureGapMs)
            .putLong(KEY_UPDATED_AT, value.updatedAtEpochMs)
            .putInt(KEY_SOURCE_FORMAT_VERSION, value.sourceFormatVersion)
        if (value.terminalDisposition == null) {
            editor.remove(KEY_TERMINAL_DISPOSITION)
        } else {
            editor.putString(KEY_TERMINAL_DISPOSITION, value.terminalDisposition.name)
        }
        if (value.terminalDiscardId == null) {
            editor.remove(KEY_TERMINAL_DISCARD_ID)
        } else {
            editor.putString(KEY_TERMINAL_DISCARD_ID, value.terminalDiscardId)
        }
        if (value.quarantineReason == null) editor.remove(KEY_QUARANTINE_REASON)
        else editor.putString(KEY_QUARANTINE_REASON, value.quarantineReason.name)
        WRITE_AUTHORITY.commit { editor.commit() }
    }

    private inline fun <reified T : Enum<T>> enumValueOrNull(value: String?): T? =
        value?.let { candidate -> enumValues<T>().firstOrNull { it.name == candidate } }

    companion object {
        private val STORE_LOCK = Any()
        private val WRITE_AUTHORITY = MainaCaptureWriteAuthority()
        private val MEETING_ID = Regex("^[A-Za-z0-9._:-]{1,128}$")
        private val DISCARD_ID = Regex("^[A-Za-z0-9._:-]{1,128}$")
        private val SOURCE_MODES = setOf("voice_recognition", "unprocessed", "camcorder")
        private const val PREFS_NAME = "maina-active-capture-control-v1"
        private const val KEY_MEETING_ID = "meeting_id"
        private const val KEY_DIRECTORY = "directory"
        private const val KEY_SOURCE_MODE = "source_mode"
        private const val KEY_CHUNK_DURATION_MS = "chunk_duration_ms"
        private const val KEY_MEETING_STARTED_AT = "meeting_started_at"
        private const val KEY_QUALIFICATION_SESSION = "qualification_session"
        private const val KEY_QUALIFICATION_EVIDENCE_DIGEST = "qualification_evidence_digest"
        private const val KEY_PHASE = "phase"
        private const val KEY_TERMINAL_DISPOSITION = "terminal_disposition"
        private const val KEY_TERMINAL_DISCARD_ID = "terminal_discard_id"
        private const val KEY_TERMINAL_EFFECT_READY = "terminal_effect_ready"
        private const val KEY_SOURCE_FORMAT_VERSION = "source_format_version"
        private const val KEY_QUARANTINE_REASON = "quarantine_reason"
        private const val KEY_OWNER = "pause_owner"
        private const val KEY_GENERATION = "generation"
        private const val KEY_COMMUNICATION_ACTIVE = "communication_active"
        private const val KEY_CHUNK_SEQUENCE = "chunk_sequence"
        private const val KEY_CAPTURE_GAP_MS = "capture_gap_ms"
        private const val KEY_UPDATED_AT = "updated_at"
        private val REQUIRED_KEYS = setOf(
            KEY_MEETING_ID,
            KEY_DIRECTORY,
            KEY_SOURCE_MODE,
            KEY_CHUNK_DURATION_MS,
            KEY_MEETING_STARTED_AT,
            KEY_QUALIFICATION_SESSION,
            KEY_PHASE,
            KEY_OWNER,
            KEY_GENERATION,
            KEY_COMMUNICATION_ACTIVE,
            KEY_CHUNK_SEQUENCE,
            KEY_CAPTURE_GAP_MS,
            KEY_UPDATED_AT,
        )
    }
}
