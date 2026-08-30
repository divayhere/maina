package com.divay.maina.recorder

import android.content.Context

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
    val phase: MainaCaptureControlPhase,
    val pauseOwner: MainaCapturePauseOwner,
    val generation: Long,
    val communicationActive: Boolean,
    val chunkSequence: Int,
    val captureGapMs: Long,
    val updatedAtEpochMs: Long,
) {
    fun reducerState(): MainaCaptureControlState = MainaCaptureControlState(
        phase = phase,
        pauseOwner = pauseOwner,
        generation = generation,
        communicationActive = communicationActive,
    )
}

internal class MainaCaptureControlStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun read(): MainaDurableCaptureControl? {
        val meetingId = prefs.getString(KEY_MEETING_ID, null)?.takeIf(String::isNotBlank) ?: return null
        val directory = prefs.getString(KEY_DIRECTORY, null)?.takeIf(String::isNotBlank) ?: return null
        val phase = enumValueOrNull<MainaCaptureControlPhase>(prefs.getString(KEY_PHASE, null)) ?: return null
        val owner = enumValueOrNull<MainaCapturePauseOwner>(prefs.getString(KEY_OWNER, null)) ?: return null
        if (phase in setOf(MainaCaptureControlPhase.IDLE, MainaCaptureControlPhase.TERMINAL)) return null
        return MainaDurableCaptureControl(
            meetingId = meetingId,
            directory = directory,
            sourceMode = prefs.getString(KEY_SOURCE_MODE, null) ?: "voice_recognition",
            chunkDurationMs = prefs.getLong(KEY_CHUNK_DURATION_MS, 5 * 60_000L),
            meetingStartedAt = prefs.getLong(KEY_MEETING_STARTED_AT, 0L),
            phase = phase,
            pauseOwner = owner,
            generation = prefs.getLong(KEY_GENERATION, 0L),
            communicationActive = prefs.getBoolean(KEY_COMMUNICATION_ACTIVE, false),
            chunkSequence = prefs.getInt(KEY_CHUNK_SEQUENCE, 0),
            captureGapMs = prefs.getLong(KEY_CAPTURE_GAP_MS, 0L),
            updatedAtEpochMs = prefs.getLong(KEY_UPDATED_AT, 0L),
        )
    }

    fun begin(
        meetingId: String,
        directory: String,
        sourceMode: String,
        chunkDurationMs: Long,
        meetingStartedAt: Long,
        state: MainaCaptureControlState,
    ): Boolean = persist(
        MainaDurableCaptureControl(
            meetingId = meetingId,
            directory = directory,
            sourceMode = sourceMode,
            chunkDurationMs = chunkDurationMs,
            meetingStartedAt = meetingStartedAt,
            phase = state.phase,
            pauseOwner = state.pauseOwner,
            generation = state.generation,
            communicationActive = state.communicationActive,
            chunkSequence = 0,
            captureGapMs = 0L,
            updatedAtEpochMs = System.currentTimeMillis(),
        ),
    )

    fun update(
        current: MainaDurableCaptureControl,
        state: MainaCaptureControlState,
        snapshot: MainaNativeAudioCapture.Snapshot,
    ): Boolean = persist(
        current.copy(
            phase = state.phase,
            pauseOwner = state.pauseOwner,
            generation = state.generation,
            communicationActive = state.communicationActive,
            chunkSequence = snapshot.chunkIndex,
            captureGapMs = snapshot.captureGapMs,
            updatedAtEpochMs = System.currentTimeMillis(),
        ),
    )

    fun clear(): Boolean = prefs.edit().clear().commit()

    private fun persist(value: MainaDurableCaptureControl): Boolean = prefs.edit()
        .putString(KEY_MEETING_ID, value.meetingId)
        .putString(KEY_DIRECTORY, value.directory)
        .putString(KEY_SOURCE_MODE, value.sourceMode)
        .putLong(KEY_CHUNK_DURATION_MS, value.chunkDurationMs)
        .putLong(KEY_MEETING_STARTED_AT, value.meetingStartedAt)
        .putString(KEY_PHASE, value.phase.name)
        .putString(KEY_OWNER, value.pauseOwner.name)
        .putLong(KEY_GENERATION, value.generation)
        .putBoolean(KEY_COMMUNICATION_ACTIVE, value.communicationActive)
        .putInt(KEY_CHUNK_SEQUENCE, value.chunkSequence)
        .putLong(KEY_CAPTURE_GAP_MS, value.captureGapMs)
        .putLong(KEY_UPDATED_AT, value.updatedAtEpochMs)
        .commit()

    private inline fun <reified T : Enum<T>> enumValueOrNull(value: String?): T? =
        value?.let { candidate -> enumValues<T>().firstOrNull { it.name == candidate } }

    companion object {
        private const val PREFS_NAME = "maina-active-capture-control-v1"
        private const val KEY_MEETING_ID = "meeting_id"
        private const val KEY_DIRECTORY = "directory"
        private const val KEY_SOURCE_MODE = "source_mode"
        private const val KEY_CHUNK_DURATION_MS = "chunk_duration_ms"
        private const val KEY_MEETING_STARTED_AT = "meeting_started_at"
        private const val KEY_PHASE = "phase"
        private const val KEY_OWNER = "pause_owner"
        private const val KEY_GENERATION = "generation"
        private const val KEY_COMMUNICATION_ACTIVE = "communication_active"
        private const val KEY_CHUNK_SEQUENCE = "chunk_sequence"
        private const val KEY_CAPTURE_GAP_MS = "capture_gap_ms"
        private const val KEY_UPDATED_AT = "updated_at"
    }
}
