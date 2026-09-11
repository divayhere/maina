package com.divay.maina.recorder

import android.content.Context
import android.os.SystemClock
import java.security.MessageDigest

internal object MainaQualificationSessionPolicy {
    private val runIdPattern = Regex(
        "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
    )

    fun canonicalRunId(value: String?): String? = value
        ?.takeIf(runIdPattern::matches)
        ?.lowercase()

    fun evidenceDigest(runId: String?): String? {
        val canonical = canonicalRunId(runId) ?: return null
        return MessageDigest.getInstance("SHA-256")
            .digest("maina-android-qualification-evidence-v1\u0000$canonical".toByteArray(Charsets.UTF_8))
            .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
    }

    fun canonicalEvidenceDigest(value: String?): String? = value
        ?.takeIf { it.matches(Regex("^[0-9a-f]{64}$")) }

    fun diagnosticsAllowed(qualificationSession: Boolean): Boolean = !qualificationSession

    fun decodeQualificationExtra(value: Any?): Boolean = value as? Boolean ?: false
}

internal class MainaQualificationSessionStateMachine(
    usedRunIds: Set<String>,
    private val persistUsedRunIds: (Set<String>) -> Boolean,
    private val ttlMs: Long = DEFAULT_TTL_MS,
) {
    private val used = usedRunIds.toMutableSet()
    private var pending: Pending? = null
    private var storageAmbiguous = false

    @Synchronized
    fun arm(runId: String, nowElapsedMs: Long): Boolean {
        val canonical = MainaQualificationSessionPolicy.canonicalRunId(runId) ?: return false
        if (storageAmbiguous || nowElapsedMs < 0L || ttlMs <= 0L) return false
        val current = pending
        if (current != null) {
            if (nowElapsedMs >= current.issuedElapsedMs && nowElapsedMs - current.issuedElapsedMs <= ttlMs) {
                return false
            }
            pending = null
        }
        val evidenceDigest = MainaQualificationSessionPolicy.evidenceDigest(canonical) ?: return false
        if (evidenceDigest in used) return false
        val next = used + evidenceDigest
        if (!persistUsedRunIds(next)) {
            storageAmbiguous = true
            return false
        }
        used.add(evidenceDigest)
        pending = Pending(canonical, nowElapsedMs)
        return true
    }

    @Synchronized
    fun consume(runId: String, nowElapsedMs: Long): Boolean {
        val canonical = MainaQualificationSessionPolicy.canonicalRunId(runId) ?: return false
        if (storageAmbiguous) return false
        val current = pending ?: return false
        val validAge = nowElapsedMs >= current.issuedElapsedMs && nowElapsedMs - current.issuedElapsedMs <= ttlMs
        pending = null
        return validAge && current.runId == canonical
    }

    private data class Pending(val runId: String, val issuedElapsedMs: Long)

    companion object {
        const val DEFAULT_TTL_MS = 15_000L
    }
}

/**
 * DUMP-protected, one-process compare-and-consume authority. Used capability
 * digests are retained in app-private storage without eviction; the live
 * pending grant is deliberately process-local and short-lived, so process
 * death or reboot invalidates it instead of reviving a public deep link.
 */
internal object MainaQualificationSessionAuthority {
    private val lock = Any()
    private var stateMachine: MainaQualificationSessionStateMachine? = null

    fun armIfFresh(context: Context, runId: String): Boolean = synchronized(lock) {
        state(context).arm(runId, SystemClock.elapsedRealtime())
    }

    fun consume(context: Context, runId: String): String? = synchronized(lock) {
        if (!state(context).consume(runId, SystemClock.elapsedRealtime())) return@synchronized null
        MainaQualificationSessionPolicy.evidenceDigest(runId)
    }

    private fun state(context: Context): MainaQualificationSessionStateMachine {
        stateMachine?.let { return it }
        val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val used = prefs.getStringSet(KEY_USED_RUN_IDS, emptySet()).orEmpty().toSet()
        return MainaQualificationSessionStateMachine(
            usedRunIds = used,
            persistUsedRunIds = { next ->
                prefs.edit().putStringSet(KEY_USED_RUN_IDS, next.toSet()).commit()
            },
        ).also { stateMachine = it }
    }

    private const val PREFS_NAME = "maina-qualification-session-v2"
    private const val KEY_USED_RUN_IDS = "used_run_ids"
}
