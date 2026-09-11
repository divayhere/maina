package com.divay.maina.recorder

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.os.Bundle
import android.os.Binder

private const val AUTOMATIC_WORK_METHOD_CLASSIFY = "classify_automatic_work"
private const val AUTOMATIC_WORK_KEY_AUTHORITY = "authority"
private const val AUTOMATIC_WORK_KEY_ALLOWED = "allowed"
private const val AUTOMATIC_WORK_KEY_SCHEMA_VERSION = "schemaVersion"
private const val AUTOMATIC_WORK_KEY_MEETING_ID = "meetingId"
private const val AUTOMATIC_WORK_KEY_DIRECTORY = "directory"
private const val AUTOMATIC_WORK_SCHEMA_VERSION = 1

/**
 * Cross-process fail-closed authority for native work that can read capture or
 * diagnostics data. MainaPostProcessingService runs in :asr, where Android's
 * SharedPreferences cache is not a safe authority. This non-exported provider
 * owns the fresh inspection in the main process instead.
 */
internal enum class MainaAutomaticWorkAuthority {
    ALLOWED,
    DEFERRED,
    DISCARDED,
    QUARANTINED,
    INVALID,
}

internal class MainaAutomaticWorkBlockedException : IllegalStateException()

internal object MainaAutomaticWorkAdmissionPolicy {
    private val meetingIdPattern = Regex("^[A-Za-z0-9._:-]{1,128}$")

    fun classify(
        inspection: MainaCaptureControlInspection,
        meetingId: String?,
    ): MainaAutomaticWorkAuthority = if (meetingId != null && !meetingIdPattern.matches(meetingId)) {
        MainaAutomaticWorkAuthority.INVALID
    } else when (inspection) {
        MainaCaptureControlInspection.Invalid -> MainaAutomaticWorkAuthority.INVALID
        is MainaCaptureControlInspection.Quarantined -> MainaAutomaticWorkAuthority.QUARANTINED
        MainaCaptureControlInspection.Absent -> MainaAutomaticWorkAuthority.ALLOWED
        is MainaCaptureControlInspection.Active -> MainaAutomaticWorkAuthority.DEFERRED
        is MainaCaptureControlInspection.Terminal -> when {
            inspection.control.terminalDisposition == MainaCaptureTerminalDisposition.DISCARD &&
                (meetingId == null || meetingId == inspection.control.meetingId) ->
                MainaAutomaticWorkAuthority.DISCARDED
            inspection.control.terminalDisposition == MainaCaptureTerminalDisposition.SAVE &&
                meetingId == inspection.control.meetingId -> MainaAutomaticWorkAuthority.ALLOWED
            else -> MainaAutomaticWorkAuthority.DEFERRED
        }
    }
}

internal object MainaCaptureAutomaticWorkGate {
    fun classify(
        context: Context,
        meetingId: String?,
        directory: String? = null,
    ): MainaAutomaticWorkAuthority = runCatching {
        val request = Bundle().apply {
            putInt(AUTOMATIC_WORK_KEY_SCHEMA_VERSION, AUTOMATIC_WORK_SCHEMA_VERSION)
            if (meetingId != null) putString(AUTOMATIC_WORK_KEY_MEETING_ID, meetingId)
            if (directory != null) putString(AUTOMATIC_WORK_KEY_DIRECTORY, directory)
        }
        val result = requireNotNull(
            context.applicationContext.contentResolver.call(
                Uri.parse("content://${context.packageName}.maina.capture-authority"),
                AUTOMATIC_WORK_METHOD_CLASSIFY,
                null,
                request,
            ),
        )
        check(result.keySet() == setOf(
            AUTOMATIC_WORK_KEY_AUTHORITY,
            AUTOMATIC_WORK_KEY_ALLOWED,
            AUTOMATIC_WORK_KEY_SCHEMA_VERSION,
        ))
        check(
            result.get(AUTOMATIC_WORK_KEY_SCHEMA_VERSION) is Int &&
                result.getInt(AUTOMATIC_WORK_KEY_SCHEMA_VERSION) == AUTOMATIC_WORK_SCHEMA_VERSION,
        )
        check(
            result.get(AUTOMATIC_WORK_KEY_AUTHORITY) is String &&
                result.get(AUTOMATIC_WORK_KEY_ALLOWED) is Boolean,
        )
        val authority = enumValues<MainaAutomaticWorkAuthority>().firstOrNull {
            it.name == result.getString(AUTOMATIC_WORK_KEY_AUTHORITY)
        } ?: error("Automatic-work authority is invalid")
        check(
            result.getBoolean(AUTOMATIC_WORK_KEY_ALLOWED) ==
                (authority == MainaAutomaticWorkAuthority.ALLOWED),
        )
        authority
    }.getOrDefault(MainaAutomaticWorkAuthority.INVALID)

    fun allows(context: Context, meetingId: String?, directory: String? = null): Boolean =
        classify(context, meetingId, directory) == MainaAutomaticWorkAuthority.ALLOWED

    fun requireAllowed(context: Context, meetingId: String?, directory: String? = null) {
        if (!allows(context, meetingId, directory)) throw MainaAutomaticWorkBlockedException()
    }

    internal fun providerResult(authority: MainaAutomaticWorkAuthority): Bundle = Bundle().apply {
        putInt(AUTOMATIC_WORK_KEY_SCHEMA_VERSION, AUTOMATIC_WORK_SCHEMA_VERSION)
        putString(AUTOMATIC_WORK_KEY_AUTHORITY, authority.name)
        putBoolean(AUTOMATIC_WORK_KEY_ALLOWED, authority == MainaAutomaticWorkAuthority.ALLOWED)
    }

    internal fun methodSupported(method: String): Boolean = method == AUTOMATIC_WORK_METHOD_CLASSIFY
}

internal class MainaCaptureAutomaticWorkAuthorityProvider : ContentProvider() {
    override fun onCreate(): Boolean = context != null

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle {
        if (!MainaCaptureAutomaticWorkGate.methodSupported(method) || arg != null || extras == null) {
            return MainaCaptureAutomaticWorkGate.providerResult(MainaAutomaticWorkAuthority.INVALID)
        }
        val appContext = context?.applicationContext
            ?: return MainaCaptureAutomaticWorkGate.providerResult(MainaAutomaticWorkAuthority.INVALID)
        if (Binder.getCallingUid() != appContext.applicationInfo.uid) {
            return MainaCaptureAutomaticWorkGate.providerResult(MainaAutomaticWorkAuthority.INVALID)
        }
        if (extras.get(AUTOMATIC_WORK_KEY_SCHEMA_VERSION) !is Int ||
            extras.getInt(AUTOMATIC_WORK_KEY_SCHEMA_VERSION) != AUTOMATIC_WORK_SCHEMA_VERSION
        ) {
            return MainaCaptureAutomaticWorkGate.providerResult(MainaAutomaticWorkAuthority.INVALID)
        }
        val meetingId = extras.get(AUTOMATIC_WORK_KEY_MEETING_ID) as? String
        val directory = extras.get(AUTOMATIC_WORK_KEY_DIRECTORY) as? String
        val expectedKeys = when {
            meetingId == null && directory == null -> setOf(AUTOMATIC_WORK_KEY_SCHEMA_VERSION)
            meetingId != null && directory == null -> setOf(
                AUTOMATIC_WORK_KEY_SCHEMA_VERSION,
                AUTOMATIC_WORK_KEY_MEETING_ID,
            )
            meetingId != null && directory != null -> setOf(
                AUTOMATIC_WORK_KEY_SCHEMA_VERSION,
                AUTOMATIC_WORK_KEY_MEETING_ID,
                AUTOMATIC_WORK_KEY_DIRECTORY,
            )
            else -> emptySet()
        }
        if (extras.keySet() != expectedKeys ||
            (directory != null && !MainaCaptureDirectoryPolicy.matches(appContext.filesDir, meetingId!!, directory))
        ) {
            return MainaCaptureAutomaticWorkGate.providerResult(MainaAutomaticWorkAuthority.INVALID)
        }
        val discarded = meetingId != null && runCatching {
            MainaPostProcessingOutbox.shared(appContext).isDiscarded(meetingId)
        }.getOrElse {
            return MainaCaptureAutomaticWorkGate.providerResult(MainaAutomaticWorkAuthority.INVALID)
        }
        val authority = if (discarded) {
            MainaAutomaticWorkAuthority.DISCARDED
        } else {
            MainaAutomaticWorkAdmissionPolicy.classify(
                MainaCaptureControlStore(appContext).inspect(),
                meetingId,
            )
        }
        return MainaCaptureAutomaticWorkGate.providerResult(authority)
    }

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor? = throw UnsupportedOperationException("Automatic-work authority supports call only")

    override fun getType(uri: Uri): String? = throw UnsupportedOperationException("Automatic-work authority supports call only")
    override fun insert(uri: Uri, values: ContentValues?): Uri? =
        throw UnsupportedOperationException("Automatic-work authority supports call only")
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int =
        throw UnsupportedOperationException("Automatic-work authority supports call only")
    override fun update(
        uri: Uri,
        values: ContentValues?,
        selection: String?,
        selectionArgs: Array<out String>?,
    ): Int = throw UnsupportedOperationException("Automatic-work authority supports call only")
}
