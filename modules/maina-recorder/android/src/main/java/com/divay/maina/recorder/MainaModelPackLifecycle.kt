package com.divay.maina.recorder

import android.content.Context
import android.os.Build
import android.system.Os
import android.system.OsConstants
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.channels.FileChannel
import java.nio.channels.FileLock
import java.nio.channels.OverlappingFileLockException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.Comparator
import java.util.UUID

internal object MainaModelPackLifecyclePolicy {
    private const val MAX_SAFE_JSON_INTEGER = 9_007_199_254_740_991L

    private val transitions = setOf(
        "unavailable>downloading:manifest_valid_and_space_preflight_passed",
        "downloading>downloading:exact_chunk_progress_committed",
        "downloading>verifying:all_declared_bytes_present",
        "downloading>failed_download:bounded_download_failure_recorded",
        "failed_download>downloading:same_manifest_and_verified_prefix",
        "verifying>staged:exact_file_set_bytes_and_hashes_verified",
        "verifying>failed_verification:verification_failure_recorded",
        "failed_verification>downloading:same_manifest_invalid_bytes_removed",
        "staged>smoke_testing:compatible_platform_runtime_selected",
        "smoke_testing>ready:smoke_receipt_and_atomic_pointer_durable",
        "smoke_testing>failed_smoke:smoke_failure_recorded",
        "ready>rollback_pending:pre_first_result_open_or_identity_failure",
        "rollback_pending>failed_smoke:previous_ready_pointer_restored",
        "ready>downloading:different_valid_manifest_staged_without_active_mutation",
    )

    fun transitionAllowed(from: String, to: String, guard: String): Boolean =
        transitions.contains("$from>$to:$guard")

    fun resumePrefix(
        storedManifest: String,
        requestedManifest: String,
        storedPath: String,
        requestedPath: String,
        storedBytes: Long,
        requestedBytes: Long,
        storedPlatform: String,
        requestedPlatform: String,
        storedChunks: List<String>,
        requestedChunks: List<String>,
        declaredChunks: List<String>,
    ): Int? {
        if (storedManifest != requestedManifest || storedPath != requestedPath || storedBytes != requestedBytes ||
            storedPlatform != requestedPlatform || storedChunks != requestedChunks || storedChunks.size > declaredChunks.size
        ) return null
        if (storedChunks.indices.any { storedChunks[it] != declaredChunks[it] }) return null
        return storedChunks.size
    }

    fun requiredSpace(
        newPackBytes: Long,
        partialOverheadBytes: Long,
        retainedRollbackBytes: Long,
        safetyMarginBytes: Long,
    ): Long? {
        if (listOf(newPackBytes, partialOverheadBytes, retainedRollbackBytes, safetyMarginBytes).any { it < 0L }) return null
        return runCatching {
            Math.addExact(Math.addExact(newPackBytes, partialOverheadBytes), Math.addExact(retainedRollbackBytes, safetyMarginBytes))
        }.getOrNull()
    }

    fun promotionAllowed(
        manifestVerified: Boolean,
        platformCompatible: Boolean,
        smokePassed: Boolean,
        previousReadyRetained: Boolean,
        conflictingWriter: Boolean,
        stagedDurable: Boolean,
    ): Boolean = manifestVerified && platformCompatible && smokePassed && previousReadyRetained && !conflictingWriter && stagedDurable

    fun cleanupAllowed(
        targetActive: Boolean,
        rollbackRetained: Boolean,
        inProgress: Boolean,
        pinnedReaders: Int,
        resultReferences: Int,
        exactSuccessorResult: Boolean,
    ): Boolean = !targetActive && !rollbackRetained && !inProgress && pinnedReaders == 0 && resultReferences == 0 && exactSuccessorResult

    fun interruptedPromotionAction(
        recordState: String,
        readyPointsToWriter: Boolean,
        previousPointerValid: Boolean,
    ): String = when {
        recordState == "ready" && readyPointsToWriter -> "complete_success_cleanup"
        recordState != "smoke_testing" -> "none"
        !readyPointsToWriter -> "mark_failed_preserve_current"
        previousPointerValid -> "rollback_to_previous"
        else -> "invalidate_first_activation"
    }

    /** Compare bounded dotted-decimal versions without narrowing through Int/Double. */
    fun compareVersions(left: String, right: String): Int {
        val a = versionComponents(left) ?: throw IllegalArgumentException("MANIFEST_INVALID")
        val b = versionComponents(right) ?: throw IllegalArgumentException("MANIFEST_INVALID")
        for (index in 0 until maxOf(a.size, b.size)) {
            val leftPart = a.getOrNull(index) ?: "0"
            val rightPart = b.getOrNull(index) ?: "0"
            val lengthComparison = leftPart.length.compareTo(rightPart.length)
            if (lengthComparison != 0) return lengthComparison
            val lexicalComparison = leftPart.compareTo(rightPart)
            if (lexicalComparison != 0) return lexicalComparison
        }
        return 0
    }

    /** Decode JSON integer values without accepting strings or lossy values. */
    fun exactPositiveSafeLong(value: Any?): Long? {
        val exact = when (value) {
            is Byte -> value.toLong()
            is Short -> value.toLong()
            is Int -> value.toLong()
            is Long -> value
            is Float -> value.toDouble().takeIf { it.isFinite() && it == it.toLong().toDouble() }?.toLong() ?: return null
            is Double -> value.takeIf { it.isFinite() && it == it.toLong().toDouble() }?.toLong() ?: return null
            else -> return null
        }
        return exact.takeIf { it in 1L..MAX_SAFE_JSON_INTEGER }
    }

    private fun versionComponents(value: String): List<String>? {
        if (value.length !in 1..64 || !value.matches(Regex("^[0-9]+(?:\\.[0-9]+){0,2}$"))) return null
        return value.split('.').map { component -> component.trimStart('0').ifEmpty { "0" } }
    }
}

/**
 * The only Android writer for downloaded Qwen model-pack state.
 *
 * Network code may supply already-downloaded immutable chunk files, but cannot
 * choose storage paths, mutate the active pack, publish readiness, or bypass
 * native hashing. Every writer call is fenced by the exact manifest SHA and a
 * process-independent file lock. Readers receive a durable pin and keep using
 * one activation generation until the recognizer is released.
 */
internal class MainaModelPackLifecycle(
    context: Context? = null,
    private val root: File = File(requireNotNull(context).filesDir, "maina-model-packs-v1"),
    private val directorySync: (File) -> Unit = { fsyncDirectory(it) },
) {
    data class PublicStatus(
        val packVersion: String?,
        val state: String,
        val bytesComplete: Long,
        val bytesTotal: Long,
        val reasonCode: String,
        val platformCompatible: Boolean,
    ) {
        fun asMap() = mapOf(
            "packId" to PACK_ID,
            "packVersion" to packVersion,
            "state" to state,
            "bytesComplete" to bytesComplete,
            "bytesTotal" to bytesTotal,
            "reasonCode" to reasonCode,
            "platformCompatible" to platformCompatible,
        )
    }

    data class ReadyHandle(
        val root: File,
        val packVersion: String,
        val manifestSha256: String,
        val activationGeneration: Long,
        val runtimeVersion: String,
        internal val readerPinName: String,
        private val pin: File,
        private val pinChannel: FileChannel,
        private val pinLock: FileLock,
        private val onReleased: () -> Unit,
    ) {
        internal fun holdsReaderPin(): Boolean = pinLock.isValid && pinChannel.isOpen && pin.isFile

        fun release() {
            var failed = false
            if (pinLock.isValid) runCatching { pinLock.release() }.onFailure { failed = true }
            runCatching { pinChannel.close() }.onFailure { failed = true }
            if (pin.exists() && !pin.delete()) failed = true
            runCatching { onReleased() }.onFailure { failed = true }
            if (failed) throw IllegalStateException("MODEL_PACK_READER_RELEASE_FAILED")
        }
    }

    data class SmokeEvidence(
        val inputSha256: String,
        val normalizedTextSha256: String,
        val startedAt: Long,
        val completedAt: Long,
    )

    private data class FileSpec(
        val path: String,
        val byteCount: Long,
        val sha256: String,
        val chunkSizeBytes: Long,
        val chunkSha256: List<String>,
    )

    private data class PlatformSpec(
        val minOsVersion: String,
        val architectures: List<String>,
        val runtimeVersion: String,
        val runtimeSha256: String,
        val smokeExpectedTextSha256: String,
    )

    private data class Manifest(
        val raw: JSONObject,
        val packVersion: String,
        val files: List<FileSpec>,
        val platform: PlatformSpec,
        val smokeInputSha256: String,
        val manifestSha256: String,
    ) {
        val bytesTotal: Long = files.sumOf { it.byteCount }
    }

    init {
        ensureDirectory(root)
        listOf("staging", "packs", "records", "readers", "results", "prepared-results").forEach { ensureDirectory(File(root, it)) }
    }

    fun status(): PublicStatus = withWriterLock {
        reconcileOpenFailureRollback()
        if (rollbackPending()) {
            return@withWriterLock PublicStatus(null, "rollback_pending", 0, 0, "MODEL_OPEN_FAILURE_ROLLBACK_PENDING", platformCompatible())
        }
        reconcileInterruptedPromotion()
        val writer = readExactJson(File(root, WRITER), WRITER_KEYS)
        val current = readExactJson(File(root, CURRENT_ACQUISITION), WRITER_KEYS)
        if (writer != null && (!validWriter(writer) || (current != null && !sameWriter(writer, current)))) {
            return@withWriterLock invalidLifecycleStatus("MODEL_PACK_WRITER_IDENTITY_MISMATCH")
        }
        val acquisition = current ?: writer
        if (acquisition != null) {
            if (!validWriter(acquisition)) return@withWriterLock invalidLifecycleStatus("MODEL_PACK_CURRENT_IDENTITY_INVALID")
            val manifestSha = acquisition.getString("manifestSha256")
            val record = readRecord(manifestSha)
                ?: return@withWriterLock invalidLifecycleStatus("MODEL_PACK_CURRENT_RECORD_MISSING")
            val manifest = readLifecycleManifest(manifestSha)
                ?: return@withWriterLock invalidLifecycleStatus("MODEL_PACK_CURRENT_MANIFEST_MISSING")
            if (record.optString("manifestSha256") != manifestSha ||
                record.optString("packVersion") != manifest.packVersion ||
                record.optLong("bytesTotal") != manifest.bytesTotal
            ) return@withWriterLock invalidLifecycleStatus("MODEL_PACK_CURRENT_IDENTITY_INVALID")
            if (record.optString("state") != "ready") {
                return@withWriterLock public(
                    manifest,
                    record.getString("state"),
                    record.getLong("bytesComplete"),
                    record.getString("reasonCode"),
                )
            }
        }
        val pointer = readExactJson(File(root, READY_POINTER), POINTER_KEYS) ?: return@withWriterLock PublicStatus(
            packVersion = null,
            state = "unavailable",
            bytesComplete = 0,
            bytesTotal = 0,
            reasonCode = "NONE",
            platformCompatible = platformCompatible(),
        )
        if (!validPointer(pointer)) return@withWriterLock PublicStatus(null, "rollback_pending", 0, 0, "READY_POINTER_INVALID", platformCompatible())
        val manifestSha = pointer.getString("manifestSha256")
        val record = readRecord(manifestSha)
        val pack = packDirectory(manifestSha)
        val manifest = readManifest(pack)
        if (record == null || record.optString("state") != "ready" ||
            record.optString("packVersion") != pointer.optString("packVersion") ||
            record.optLong("activationGeneration") != pointer.optLong("activationGeneration") ||
            manifest == null || manifest.manifestSha256 != manifestSha || manifest.packVersion != pointer.optString("packVersion")) {
            return@withWriterLock PublicStatus(null, "rollback_pending", 0, 0, "READY_POINTER_INVALID", platformCompatible())
        }
        PublicStatus(
            packVersion = pointer.optString("packVersion"),
            state = "ready",
            bytesComplete = record.optLong("bytesComplete", 0),
            bytesTotal = record.optLong("bytesTotal", 0),
            reasonCode = "NONE",
            platformCompatible = platformCompatible(),
        )
    }

    fun begin(manifestJson: String, partialOverheadBytes: Long, safetyMarginBytes: Long): PublicStatus = withWriterLock {
        reconcileOpenFailureRollback()
        requireNoPendingRollback()
        reconcileInterruptedPromotion()
        val manifest = parseManifest(manifestJson)
        requirePlatformCompatible(manifest)
        val writer = readExactJson(File(root, WRITER), WRITER_KEYS)
        if (writer != null) {
            if (!validSha(writer.optString("manifestSha256")) || writer.optString("platform") != PLATFORM) {
                throw IllegalStateException("MODEL_PACK_WRITER_IDENTITY_MISMATCH")
            }
            if (writer.optString("manifestSha256") != manifest.manifestSha256) throw IllegalStateException("MODEL_PACK_WRITER_CONFLICT")
        }
        val rollbackBytes = retainedRollbackBytes()
        val required = MainaModelPackLifecyclePolicy.requiredSpace(
            manifest.bytesTotal,
            partialOverheadBytes,
            rollbackBytes,
            safetyMarginBytes,
        ) ?: throw IllegalArgumentException("STORAGE_PREFLIGHT_FAILED")
        if (root.usableSpace < required) throw IllegalStateException("STORAGE_PREFLIGHT_FAILED")

        val acquisition = writerIdentity(manifest.manifestSha256)
        writeJsonAtomic(File(root, WRITER), acquisition)
        writeJsonAtomic(File(root, CURRENT_ACQUISITION), acquisition)
        val stage = stagingDirectory(manifest.manifestSha256)
        val previous = readRecord(manifest.manifestSha256)
        prepareStageForResume(stage, manifest, previous)
        ensureDirectory(stage)
        writeJsonAtomic(File(stage, "manifest.json"), manifest.raw)
        val priorState = previous?.optString("state") ?: "unavailable"
        val guard = when (priorState) {
            "failed_download" -> "same_manifest_and_verified_prefix"
            "failed_verification" -> "same_manifest_invalid_bytes_removed"
            else -> "manifest_valid_and_space_preflight_passed"
        }
        if (priorState !in setOf("unavailable", "failed_download", "failed_verification", "downloading") ||
            (priorState != "downloading" && !MainaModelPackLifecyclePolicy.transitionAllowed(priorState, "downloading", guard))
        ) throw IllegalStateException("LIFECYCLE_TRANSITION_INVALID")
        val progress = scanVerifiedProgress(stage, manifest)
        writeRecord(manifest, "downloading", progress.bytes, "NONE", progress.chunks)
        public(manifest, "downloading", progress.bytes, "NONE")
    }

    fun stageChunk(manifestJson: String, relativePath: String, chunkIndex: Int, sourceValue: String): PublicStatus = withWriterLock {
        reconcileOpenFailureRollback()
        requireNoPendingRollback()
        reconcileInterruptedPromotion()
        val manifest = parseManifest(manifestJson)
        requireWriter(manifest)
        val record = requireRecord(manifest, setOf("downloading", "failed_download"))
        val spec = manifest.files.singleOrNull { it.path == relativePath }
            ?: throw IllegalArgumentException("MANIFEST_PATH_INVALID")
        val source = fileFromValue(sourceValue)
        if (!regularFile(source)) throw IllegalArgumentException("CHUNK_SOURCE_INVALID")
        val progress = decodeProgress(record, manifest)
        val completed = progress[relativePath].orEmpty()
        if (chunkIndex != completed.size || chunkIndex !in spec.chunkSha256.indices) {
            throw IllegalStateException("RESUME_PREFIX_INVALID")
        }
        val expectedBytes = minOf(spec.chunkSizeBytes, spec.byteCount - spec.chunkSizeBytes * chunkIndex)
        if (source.length() != expectedBytes || sha256(source) != spec.chunkSha256[chunkIndex]) {
            fail(manifest, "failed_download", "DOWNLOAD_CHUNK_MISMATCH", progress)
            throw IllegalStateException("DOWNLOAD_CHUNK_MISMATCH")
        }
        val target = safeChild(stagingDirectory(manifest.manifestSha256), relativePath)
        ensureDirectory(target.parentFile!!)
        val currentBytes = completed.size * spec.chunkSizeBytes
        if ((target.length() != currentBytes) || (target.exists() && !regularFile(target))) {
            fail(manifest, "failed_download", "RESUME_PREFIX_INVALID", progress)
            throw IllegalStateException("RESUME_PREFIX_INVALID")
        }
        try {
            FileOutputStream(target, true).use { output ->
                FileInputStream(source).use { input -> input.copyTo(output) }
                output.fd.sync()
            }
        } catch (cause: Throwable) {
            fail(manifest, "failed_download", "DOWNLOAD_WRITE_FAILED", progress)
            throw IllegalStateException("DOWNLOAD_WRITE_FAILED", cause)
        }
        val next = progress.toMutableMap()
        next[relativePath] = completed + spec.chunkSha256[chunkIndex]
        val bytes = verifiedBytes(next, manifest)
        writeRecord(manifest, "downloading", bytes, "NONE", next)
        public(manifest, "downloading", bytes, "NONE")
    }

    fun verifyStaged(manifestJson: String): PublicStatus = withWriterLock {
        reconcileOpenFailureRollback()
        requireNoPendingRollback()
        reconcileInterruptedPromotion()
        val manifest = parseManifest(manifestJson)
        requireWriter(manifest)
        val record = requireRecord(manifest, setOf("downloading", "failed_verification"))
        val state = record.optString("state")
        val guard = if (state == "failed_verification") "same_manifest_invalid_bytes_removed" else "all_declared_bytes_present"
        if (state != "downloading" && !MainaModelPackLifecyclePolicy.transitionAllowed(state, "downloading", guard)) {
            throw IllegalStateException("LIFECYCLE_TRANSITION_INVALID")
        }
        val stage = stagingDirectory(manifest.manifestSha256)
        val observed = enumerateFiles(stage).filter { it != "manifest.json" }
        if (observed.toSet() != manifest.files.map { it.path }.toSet()) {
            fail(manifest, "failed_verification", "MANIFEST_FILE_SET_MISMATCH", emptyMap())
            throw IllegalStateException("MANIFEST_FILE_SET_MISMATCH")
        }
        writeRecord(manifest, "verifying", manifest.bytesTotal, "NONE", completeProgress(manifest))
        for (spec in manifest.files) {
            val file = safeChild(stage, spec.path)
            if (!regularFile(file) || file.length() != spec.byteCount || sha256(file) != spec.sha256 || chunkHashes(file, spec.chunkSizeBytes) != spec.chunkSha256) {
                fail(manifest, "failed_verification", "FILE_EVIDENCE_MISMATCH", emptyMap())
                throw IllegalStateException("FILE_EVIDENCE_MISMATCH")
            }
        }
        writeRecord(manifest, "staged", manifest.bytesTotal, "NONE", completeProgress(manifest))
        public(manifest, "staged", manifest.bytesTotal, "NONE")
    }

    fun smokeRoot(manifestJson: String): File = withWriterLock {
        reconcileOpenFailureRollback()
        requireNoPendingRollback()
        reconcileInterruptedPromotion()
        val manifest = parseManifest(manifestJson)
        requireWriter(manifest)
        requireRecord(manifest, setOf("staged"))
        stagingDirectory(manifest.manifestSha256)
    }

    fun promote(manifestJson: String, evidence: SmokeEvidence): PublicStatus = withWriterLock {
        reconcileOpenFailureRollback()
        requireNoPendingRollback()
        reconcileInterruptedPromotion()
        val manifest = parseManifest(manifestJson)
        requireWriter(manifest)
        requireRecord(manifest, setOf("staged"))
        if (evidence.inputSha256 != manifest.smokeInputSha256 ||
            evidence.normalizedTextSha256 != manifest.platform.smokeExpectedTextSha256 ||
            evidence.startedAt < 0L || evidence.completedAt < evidence.startedAt
        ) {
            fail(manifest, "failed_smoke", "SMOKE_RECEIPT_MISMATCH", completeProgress(manifest))
            throw IllegalStateException("SMOKE_RECEIPT_MISMATCH")
        }
        writeRecord(manifest, "smoke_testing", manifest.bytesTotal, "NONE", completeProgress(manifest))
        val oldReady = readExactJson(File(root, READY_POINTER), POINTER_KEYS)
        if (oldReady != null) {
            val retained = readManifest(packDirectory(oldReady.optString("manifestSha256")))
            if (!validPointer(oldReady) || retained == null || retained.manifestSha256 != oldReady.optString("manifestSha256") ||
                retained.packVersion != oldReady.optString("packVersion")
            ) throw IllegalStateException("ROLLBACK_RETENTION_FAILED")
        } else if (File(root, PREVIOUS_POINTER).exists()) {
            if (!File(root, PREVIOUS_POINTER).delete()) throw IllegalStateException("MODEL_PACK_STORAGE_INVALID")
            directorySync(root)
        }
        val destination = packDirectory(manifest.manifestSha256)
        val stage = stagingDirectory(manifest.manifestSha256)
        if (destination.exists() || !stage.renameTo(destination)) {
            fail(manifest, "failed_smoke", "PROMOTION_ATOMICITY_FAILED", completeProgress(manifest))
            throw IllegalStateException("PROMOTION_ATOMICITY_FAILED")
        }
        directorySync(File(root, "packs"))
        if (oldReady != null) writeJsonAtomic(File(root, PREVIOUS_POINTER), oldReady)
        val generation = (oldReady?.optLong("activationGeneration", 0L) ?: 0L) + 1L
        val pointer = JSONObject()
            .put("packId", PACK_ID)
            .put("packVersion", manifest.packVersion)
            .put("manifestSha256", manifest.manifestSha256)
            .put("platform", PLATFORM)
            .put("activationGeneration", generation)
            .put("runtimeVersion", RUNTIME_VERSION)
        writeJsonAtomic(File(root, READY_POINTER), pointer)
        writeRecord(manifest, "ready", manifest.bytesTotal, "NONE", completeProgress(manifest), generation)
        File(root, WRITER).delete()
        directorySync(root)
        public(manifest, "ready", manifest.bytesTotal, "NONE")
    }

    fun acquireReady(): ReadyHandle? = withWriterLock {
        reconcileOpenFailureRollback()
        requireNoPendingRollback()
        reconcileInterruptedPromotion()
        val pointer = readExactJson(File(root, READY_POINTER), POINTER_KEYS) ?: return@withWriterLock null
        if (!validPointer(pointer)) throw IllegalStateException("READY_POINTER_INVALID")
        val manifestSha = pointer.optString("manifestSha256")
        val record = readRecord(manifestSha) ?: throw IllegalStateException("READY_POINTER_INVALID")
        if (record.optString("state") != "ready" || record.optString("packVersion") != pointer.optString("packVersion") ||
            record.optLong("activationGeneration") != pointer.optLong("activationGeneration")
        ) throw IllegalStateException("READY_POINTER_INVALID")
        val pack = packDirectory(manifestSha)
        val manifest = readManifest(pack) ?: throw IllegalStateException("READY_POINTER_INVALID")
        if (manifest.manifestSha256 != manifestSha || manifest.packVersion != pointer.optString("packVersion")) {
            throw IllegalStateException("READY_POINTER_INVALID")
        }
        val pinRoot = File(File(root, "readers"), manifestSha)
        ensureDirectory(pinRoot)
        val pin = File(pinRoot, UUID.randomUUID().toString())
        if (!pin.createNewFile()) throw IllegalStateException("MODEL_PACK_READER_PIN_FAILED")
        FileOutputStream(pin).use { output ->
            output.write("generation=${pointer.getLong("activationGeneration")}\n".toByteArray())
            output.fd.sync()
        }
        val pinChannel = RandomAccessFile(pin, "rw").channel
        val pinLock = try {
            pinChannel.lock()
        } catch (cause: Throwable) {
            runCatching { pinChannel.close() }
            runCatching { pin.delete() }
            throw IllegalStateException("MODEL_PACK_READER_PIN_FAILED", cause)
        }
        ReadyHandle(
            root = pack,
            packVersion = pointer.getString("packVersion"),
            manifestSha256 = manifestSha,
            activationGeneration = pointer.getLong("activationGeneration"),
            runtimeVersion = pointer.getString("runtimeVersion"),
            readerPinName = pin.name,
            pin = pin,
            pinChannel = pinChannel,
            pinLock = pinLock,
            onReleased = ::reconcileAfterReaderRelease,
        )
    }

    fun rollbackAfterOpenFailure(handle: ReadyHandle): Boolean = withWriterLock {
        reconcileOpenFailureRollback()
        if (rollbackPending()) return@withWriterLock true
        reconcileInterruptedPromotion()
        if (!handle.holdsReaderPin()) throw IllegalStateException("MODEL_PACK_READER_PIN_INVALID")
        val current = readExactJson(File(root, READY_POINTER), POINTER_KEYS) ?: return@withWriterLock false
        if (current.optString("manifestSha256") != handle.manifestSha256 ||
            current.optLong("activationGeneration") != handle.activationGeneration
        ) return@withWriterLock false
        if (readManifest(packDirectory(handle.manifestSha256)) == null) return@withWriterLock false
        val previous = readExactJson(File(root, PREVIOUS_POINTER), POINTER_KEYS)
        if (previous != null && !validPointer(previous)) return@withWriterLock false
        if (hasExactResultFor(handle.manifestSha256, handle.activationGeneration)) return@withWriterLock false
        writeJsonAtomic(
            File(root, ROLLBACK_INTENT),
            rollbackIntent(handle.manifestSha256, handle.activationGeneration, previous, handle.readerPinName),
        )
        reconcileOpenFailureRollback()
        true
    }

    fun resultPayloadSha256(payload: Map<String, Any?>): String =
        sha256(canonicalJson(JSONObject(payload)).toByteArray(Charsets.UTF_8))

    fun resultIdForPayloadSha256(payloadSha256: String): String? =
        payloadSha256.takeIf(::validSha)?.let { "npr_${it.take(32)}" }

    /**
     * A conservative retention fence written before the native Outbox commit.
     * It is intentionally not a successful result mapping: if SQLite rolls
     * back, a later committed read can finalize a different payload without a
     * phantom first-result claim. The prepared fence merely prevents deletion
     * of bytes that may already back an externally committing transaction.
     */
    fun prepareExactResult(
        modelId: String,
        modelVersion: String,
        runtimeVersion: String,
        manifestSha256: String?,
        activationGeneration: Long?,
        resultId: String,
        resultPayloadSha256: String,
    ): Boolean = withWriterLock {
        reconcileOpenFailureRollback()
        reconcileInterruptedPromotion()
        if (manifestSha256 == null || activationGeneration == null) {
            return@withWriterLock manifestSha256 == null && activationGeneration == null &&
                modelId == ENGINE_ID && modelVersion == LEGACY_MODEL_VERSION && runtimeVersion == RUNTIME_VERSION &&
                validId(resultId) && validSha(resultPayloadSha256)
        }
        val lifecycleRecordSha256 = validateReadyManagedResultIdentity(
            modelId, modelVersion, runtimeVersion, manifestSha256, activationGeneration, resultId, resultPayloadSha256,
        ) ?: return@withWriterLock false
        val preparedRoot = File(File(root, "prepared-results"), "$manifestSha256-$activationGeneration")
        ensureDirectory(preparedRoot)
        val prepared = File(preparedRoot, "$resultId.json")
        val payload = JSONObject()
            .put("schemaVersion", "maina.model-pack-prepared-result.v1")
            .put("manifestSha256", manifestSha256)
            .put("activationGeneration", activationGeneration)
            .put("modelId", modelId)
            .put("modelVersion", modelVersion)
            .put("runtimeVersion", runtimeVersion)
            .put("lifecycleRecordSha256", lifecycleRecordSha256)
            .put("resultId", resultId)
            .put("resultPayloadSha256", resultPayloadSha256)
        val existing = readExactJson(prepared, PREPARED_RESULT_KEYS)
        if (existing != null) return@withWriterLock canonicalJson(existing) == canonicalJson(payload)
        writeJsonAtomic(prepared, payload)
        true
    }

    fun noteExactResult(
        modelId: String,
        modelVersion: String,
        runtimeVersion: String,
        manifestSha256: String?,
        activationGeneration: Long?,
        resultId: String,
        resultPayloadSha256: String,
    ): Boolean = withWriterLock {
        reconcileOpenFailureRollback()
        reconcileInterruptedPromotion()
        if (modelId != ENGINE_ID || !validId(modelVersion) || runtimeVersion != RUNTIME_VERSION ||
            !validId(resultId) || !validSha(resultPayloadSha256)
        ) return@withWriterLock false
        if (manifestSha256 == null || activationGeneration == null) {
            return@withWriterLock manifestSha256 == null && activationGeneration == null &&
                modelVersion == LEGACY_MODEL_VERSION
        }
        val lifecycleRecordSha256 = validateReadyManagedResultIdentity(
            modelId, modelVersion, runtimeVersion, manifestSha256, activationGeneration, resultId, resultPayloadSha256,
        ) ?: preparedLifecycleRecordSha256(
            modelId, modelVersion, runtimeVersion, manifestSha256, activationGeneration, resultId, resultPayloadSha256,
        ) ?: return@withWriterLock false
        val resultsRoot = File(root, "results")
        val mappings = resultsRoot.listFiles()?.toList().orEmpty()
        if (mappings.any { !regularFile(it) || !it.name.matches(Regex("^[a-f0-9]{64}-[1-9][0-9]*\\.json$")) }) {
            return@withWriterLock false
        }
        for (candidate in mappings) {
            val existing = readExactJson(candidate, RESULT_KEYS) ?: return@withWriterLock false
            if (!validResultRecord(existing)) return@withWriterLock false
            val sameTuple = existing.optString("modelId") == modelId &&
                existing.optString("modelVersion") == modelVersion &&
                existing.optString("runtimeVersion") == runtimeVersion
            if (sameTuple && (existing.optString("manifestSha256") != manifestSha256 ||
                    existing.optLong("activationGeneration") != activationGeneration)
            ) return@withWriterLock false
            val referenced = existing.getJSONArray("referencedResultIds")
            if ((0 until referenced.length()).any { referenced.optString(it) == resultId } &&
                (existing.optString("manifestSha256") != manifestSha256 ||
                    existing.optLong("activationGeneration") != activationGeneration)
            ) return@withWriterLock false
        }
        val mapping = File(resultsRoot, "$manifestSha256-$activationGeneration.json")
        val existing = readExactJson(mapping, RESULT_KEYS)
        if (existing != null && (!validResultRecord(existing) ||
                existing.optString("manifestSha256") != manifestSha256 ||
                existing.optLong("activationGeneration") != activationGeneration ||
                existing.optString("modelId") != modelId ||
                existing.optString("modelVersion") != modelVersion ||
                existing.optString("runtimeVersion") != runtimeVersion ||
                existing.optString("lifecycleRecordSha256") != lifecycleRecordSha256)
        ) return@withWriterLock false
        val ids = existing?.getJSONArray("referencedResultIds") ?: JSONArray()
        if ((0 until ids.length()).none { ids.optString(it) == resultId }) ids.put(resultId)
        val first = existing?.optString("firstExactResultId")?.takeIf { it.isNotEmpty() } ?: resultId
        val firstSha = existing?.optString("firstExactResultSha256")?.takeIf { it.isNotEmpty() } ?: resultPayloadSha256
        if (first == resultId && firstSha != resultPayloadSha256) return@withWriterLock false
        writeJsonAtomic(mapping, JSONObject()
            .put("manifestSha256", manifestSha256)
            .put("platform", PLATFORM)
            .put("activationGeneration", activationGeneration)
            .put("modelId", modelId)
            .put("modelVersion", modelVersion)
            .put("runtimeVersion", runtimeVersion)
            .put("lifecycleRecordSha256", lifecycleRecordSha256)
            .put("packRetained", true)
            .put("firstExactResultId", first)
            .put("firstExactResultSha256", firstSha)
            .put("referencedResultIds", ids))
        true
    }

    private fun validateReadyManagedResultIdentity(
        modelId: String,
        modelVersion: String,
        runtimeVersion: String,
        manifestSha256: String,
        activationGeneration: Long,
        resultId: String,
        resultPayloadSha256: String,
    ): String? {
        if (modelId != ENGINE_ID || !validId(modelVersion) || runtimeVersion != RUNTIME_VERSION ||
            !validSha(manifestSha256) || activationGeneration <= 0L || !validId(resultId) || !validSha(resultPayloadSha256)
        ) return null
        val record = readRecord(manifestSha256) ?: return null
        val manifest = readManifest(packDirectory(manifestSha256)) ?: return null
        if (record.optString("state") != "ready" || record.optString("manifestSha256") != manifestSha256 ||
            record.optString("packVersion") != modelVersion || record.optLong("activationGeneration") != activationGeneration ||
            manifest.manifestSha256 != manifestSha256 || manifest.packVersion != modelVersion ||
            manifest.platform.runtimeVersion != runtimeVersion
        ) return null
        return sha256(recordFile(manifestSha256))
    }

    private fun preparedLifecycleRecordSha256(
        modelId: String,
        modelVersion: String,
        runtimeVersion: String,
        manifestSha256: String,
        activationGeneration: Long,
        resultId: String,
        resultPayloadSha256: String,
    ): String? {
        if (modelId != ENGINE_ID || !validId(modelVersion) || runtimeVersion != RUNTIME_VERSION ||
            !validSha(manifestSha256) || activationGeneration <= 0L || !validId(resultId) || !validSha(resultPayloadSha256)
        ) return null
        val record = readRecord(manifestSha256) ?: return null
        val manifest = readManifest(packDirectory(manifestSha256)) ?: return null
        if (record.optString("state") !in setOf("ready", "rollback_pending", "failed_smoke") ||
            record.optString("manifestSha256") != manifestSha256 ||
            record.optString("packVersion") != modelVersion || record.optLong("activationGeneration") != activationGeneration ||
            manifest.manifestSha256 != manifestSha256 || manifest.packVersion != modelVersion ||
            manifest.platform.runtimeVersion != runtimeVersion
        ) return null
        val prepared = readExactJson(
            File(File(File(root, "prepared-results"), "$manifestSha256-$activationGeneration"), "$resultId.json"),
            PREPARED_RESULT_KEYS,
        ) ?: return null
        if (prepared.optString("schemaVersion") != "maina.model-pack-prepared-result.v1" ||
            prepared.optString("manifestSha256") != manifestSha256 ||
            prepared.optLong("activationGeneration") != activationGeneration || prepared.optString("modelId") != modelId ||
            prepared.optString("modelVersion") != modelVersion || prepared.optString("runtimeVersion") != runtimeVersion ||
            prepared.optString("resultId") != resultId || prepared.optString("resultPayloadSha256") != resultPayloadSha256 ||
            !validSha(prepared.optString("lifecycleRecordSha256"))
        ) return null
        return prepared.getString("lifecycleRecordSha256")
    }

    private fun validResultRecord(record: JSONObject): Boolean {
        val ids = record.optJSONArray("referencedResultIds") ?: return false
        val values = (0 until ids.length()).map { ids.optString(it) }
        return validSha(record.optString("manifestSha256")) && record.optString("platform") == PLATFORM &&
            record.optLong("activationGeneration") > 0L && record.optString("modelId") == ENGINE_ID &&
            validId(record.optString("modelVersion")) && record.optString("runtimeVersion") == RUNTIME_VERSION &&
            validSha(record.optString("lifecycleRecordSha256")) && record.optBoolean("packRetained", false) &&
            validId(record.optString("firstExactResultId")) && validSha(record.optString("firstExactResultSha256")) &&
            values.isNotEmpty() && values.all(::validId) && values.toSet().size == values.size &&
            record.optString("firstExactResultId") in values
    }

    private fun hasExactResultFor(manifestSha256: String, activationGeneration: Long): Boolean {
        val mapping = File(File(root, "results"), "$manifestSha256-$activationGeneration.json")
        if (!mapping.exists()) return false
        val record = readExactJson(mapping, RESULT_KEYS)
            ?: throw IllegalStateException("MODEL_PACK_RESULT_BINDING_INVALID")
        if (!validResultRecord(record) ||
            record.optString("manifestSha256") != manifestSha256 ||
            record.optLong("activationGeneration") != activationGeneration ||
            !resultLifecycleEvidenceExists(record)
        ) throw IllegalStateException("MODEL_PACK_RESULT_BINDING_INVALID")
        return true
    }

    private fun resultLifecycleEvidenceExists(result: JSONObject): Boolean {
        val manifestSha256 = result.optString("manifestSha256")
        val generation = result.optLong("activationGeneration")
        val currentRecordSha = runCatching { sha256(recordFile(manifestSha256)) }.getOrNull()
        if (currentRecordSha == result.optString("lifecycleRecordSha256")) return true
        return preparedLifecycleRecordSha256(
            result.optString("modelId"),
            result.optString("modelVersion"),
            result.optString("runtimeVersion"),
            manifestSha256,
            generation,
            result.optString("firstExactResultId"),
            result.optString("firstExactResultSha256"),
        ) == result.optString("lifecycleRecordSha256")
    }

    private fun hasPreparedResultFor(manifestSha256: String, activationGeneration: Long): Boolean {
        val preparedRoot = File(File(root, "prepared-results"), "$manifestSha256-$activationGeneration")
        if (!preparedRoot.exists()) return false
        if (!preparedRoot.isDirectory || Files.isSymbolicLink(preparedRoot.toPath())) {
            throw IllegalStateException("MODEL_PACK_PREPARED_RESULT_INVALID")
        }
        val prepared = preparedRoot.listFiles()
            ?: throw IllegalStateException("MODEL_PACK_PREPARED_RESULT_INVALID")
        if (prepared.isEmpty()) return false
        for (file in prepared) {
            if (!regularFile(file) || !file.name.matches(Regex("^npr_[a-f0-9]{32}\\.json$"))) {
                throw IllegalStateException("MODEL_PACK_PREPARED_RESULT_INVALID")
            }
            val record = readExactJson(file, PREPARED_RESULT_KEYS)
                ?: throw IllegalStateException("MODEL_PACK_PREPARED_RESULT_INVALID")
            if (record.optString("schemaVersion") != "maina.model-pack-prepared-result.v1" ||
                record.optString("manifestSha256") != manifestSha256 ||
                record.optLong("activationGeneration") != activationGeneration ||
                record.optString("modelId") != ENGINE_ID || !validId(record.optString("modelVersion")) ||
                record.optString("runtimeVersion") != RUNTIME_VERSION ||
                record.optString("lifecycleRecordSha256") != sha256(recordFile(manifestSha256)) ||
                record.optString("resultId") != file.name.removeSuffix(".json") ||
                !validSha(record.optString("resultPayloadSha256"))
            ) throw IllegalStateException("MODEL_PACK_PREPARED_RESULT_INVALID")
        }
        return true
    }

    private fun hasActiveReadyReaders(manifestSha256: String, ignoredPinName: String): Boolean {
        val pinRoot = File(File(root, "readers"), manifestSha256)
        val pins = pinRoot.listFiles() ?: throw IllegalStateException("MODEL_PACK_READER_PIN_INVALID")
        if (pins.any { !regularFile(it) || !validId(it.name) }) {
            throw IllegalStateException("MODEL_PACK_READER_PIN_INVALID")
        }
        for (pin in pins) {
            val channel = RandomAccessFile(pin, "rw").channel
            val lock = try {
                channel.tryLock()
            } catch (_: OverlappingFileLockException) {
                null
            } catch (cause: Throwable) {
                runCatching { channel.close() }
                throw IllegalStateException("MODEL_PACK_READER_PIN_INVALID", cause)
            }
            if (lock == null) {
                runCatching { channel.close() }
                if (pin.name != ignoredPinName) return true
                continue
            }
            runCatching { lock.release() }
                .onFailure { runCatching { channel.close() }; throw IllegalStateException("MODEL_PACK_READER_PIN_INVALID", it) }
            runCatching { channel.close() }
                .onFailure { throw IllegalStateException("MODEL_PACK_READER_PIN_INVALID", it) }
            if (!pin.delete()) throw IllegalStateException("MODEL_PACK_READER_PIN_INVALID")
        }
        return false
    }

    private fun reconcileAfterReaderRelease() = withWriterLock {
        reconcileOpenFailureRollback()
    }

    private fun rollbackPending(): Boolean = File(root, ROLLBACK_INTENT).exists()

    private fun requireNoPendingRollback() {
        if (rollbackPending()) throw IllegalStateException("MODEL_OPEN_FAILURE_ROLLBACK_PENDING")
    }

    private data class Progress(val bytes: Long, val chunks: Map<String, List<String>>)

    private fun prepareStageForResume(stage: File, manifest: Manifest, previous: JSONObject?) {
        if (!stage.exists()) return
        val priorState = previous?.optString("state") ?: "unavailable"
        if (priorState in setOf("unavailable", "failed_verification")) {
            deleteTreeNoFollow(stage)
            directorySync(File(root, "staging"))
            return
        }
        if (priorState !in setOf("downloading", "failed_download")) return
        val progress = decodeProgress(previous!!, manifest)
        val observed = enumerateFiles(stage).filter { it != "manifest.json" }
        if (observed.any { path -> manifest.files.none { it.path == path } }) {
            throw IllegalStateException("RESUME_PREFIX_INVALID")
        }
        for (spec in manifest.files) {
            val verified = progress[spec.path].orEmpty()
            if (verified.indices.any { it >= spec.chunkSha256.size || verified[it] != spec.chunkSha256[it] }) {
                throw IllegalStateException("RESUME_PREFIX_INVALID")
            }
            val expectedBytes = verified.indices.sumOf { index ->
                minOf(spec.chunkSizeBytes, spec.byteCount - spec.chunkSizeBytes * index)
            }
            val file = safeChild(stage, spec.path)
            if (!file.exists()) {
                if (expectedBytes != 0L) throw IllegalStateException("RESUME_PREFIX_INVALID")
                continue
            }
            if (!regularFile(file) || file.length() < expectedBytes || file.length() > spec.byteCount) {
                throw IllegalStateException("RESUME_PREFIX_INVALID")
            }
            if (file.length() > expectedBytes) {
                RandomAccessFile(file, "rw").use { output ->
                    output.setLength(expectedBytes)
                    output.fd.sync()
                }
            }
            if (chunkHashes(file, spec.chunkSizeBytes) != verified) throw IllegalStateException("RESUME_PREFIX_INVALID")
        }
        directorySync(stage)
    }

    private fun scanVerifiedProgress(stage: File, manifest: Manifest): Progress {
        val progress = linkedMapOf<String, List<String>>()
        for (spec in manifest.files) {
            val file = safeChild(stage, spec.path)
            if (!file.exists()) continue
            if (!regularFile(file) || file.length() > spec.byteCount) throw IllegalStateException("RESUME_PREFIX_INVALID")
            val hashes = chunkHashes(file, spec.chunkSizeBytes)
            if (file.length() % spec.chunkSizeBytes != 0L && file.length() != spec.byteCount) throw IllegalStateException("RESUME_PREFIX_INVALID")
            if (hashes.indices.any { it >= spec.chunkSha256.size || hashes[it] != spec.chunkSha256[it] }) {
                throw IllegalStateException("RESUME_PREFIX_INVALID")
            }
            progress[spec.path] = hashes
        }
        return Progress(verifiedBytes(progress, manifest), progress)
    }

    private fun verifiedBytes(progress: Map<String, List<String>>, manifest: Manifest): Long = manifest.files.sumOf { spec ->
        progress[spec.path].orEmpty().indices.sumOf { index -> minOf(spec.chunkSizeBytes, spec.byteCount - spec.chunkSizeBytes * index) }
    }

    private fun completeProgress(manifest: Manifest): Map<String, List<String>> = manifest.files.associate { it.path to it.chunkSha256 }

    private fun decodeProgress(record: JSONObject, manifest: Manifest): Map<String, List<String>> {
        val progress = record.optJSONObject("verifiedChunks") ?: JSONObject()
        return manifest.files.associate { spec ->
            val array = progress.optJSONArray(spec.path) ?: JSONArray()
            spec.path to (0 until array.length()).map { array.getString(it) }
        }
    }

    private fun public(manifest: Manifest, state: String, bytes: Long, reason: String) =
        PublicStatus(manifest.packVersion, state, bytes, manifest.bytesTotal, reason, true)

    private fun fail(manifest: Manifest, state: String, reason: String, progress: Map<String, List<String>>) {
        writeJsonAtomic(File(root, CURRENT_ACQUISITION), writerIdentity(manifest.manifestSha256))
        writeRecord(manifest, state, verifiedBytes(progress, manifest), reason, progress)
        File(root, WRITER).delete()
        directorySync(root)
    }

    private fun writeRecord(
        manifest: Manifest,
        state: String,
        bytesComplete: Long,
        reasonCode: String,
        progress: Map<String, List<String>>,
        activationGeneration: Long = 0L,
    ) {
        val chunks = JSONObject()
        progress.toSortedMap().forEach { (path, values) -> chunks.put(path, JSONArray(values)) }
        writeJsonAtomic(recordFile(manifest.manifestSha256), JSONObject()
            .put("schemaVersion", "maina.model-pack-lifecycle-record.v1")
            .put("packId", PACK_ID)
            .put("packVersion", manifest.packVersion)
            .put("manifestSha256", manifest.manifestSha256)
            .put("platform", PLATFORM)
            .put("activationGeneration", activationGeneration)
            .put("state", state)
            .put("bytesComplete", bytesComplete)
            .put("bytesTotal", manifest.bytesTotal)
            .put("reasonCode", reasonCode)
            .put("verifiedChunks", chunks))
    }

    private fun parseManifest(value: String): Manifest {
        if (value.length !in 2..MAX_MANIFEST_CHARACTERS) throw IllegalArgumentException("MANIFEST_INVALID")
        val raw = runCatching { JSONObject(value) }.getOrElse { throw IllegalArgumentException("MANIFEST_INVALID") }
        requireExactKeys(raw, MANIFEST_KEYS, "MANIFEST_INVALID")
        val schemaVersion = exactString(raw, "schemaVersion")
        val packId = exactString(raw, "packId")
        val packVersion = exactString(raw, "packVersion") ?: throw IllegalArgumentException("MANIFEST_INVALID")
        val engineId = exactString(raw, "engineId")
        val formatVersion = exactString(raw, "formatVersion")
        val smokeInputSha256 = exactString(raw, "smokeInputSha256") ?: throw IllegalArgumentException("MANIFEST_INVALID")
        val manifestSha256 = exactString(raw, "manifestSha256") ?: throw IllegalArgumentException("MANIFEST_INVALID")
        if (schemaVersion != "maina.model-pack-manifest.v1" || packId != PACK_ID ||
            engineId != ENGINE_ID || formatVersion != "1" ||
            !validId(packVersion) || !validSha(smokeInputSha256) || !validSha(manifestSha256)
        ) throw IllegalArgumentException("MANIFEST_INVALID")
        val filesValue = raw.opt("files") as? JSONArray ?: throw IllegalArgumentException("MANIFEST_INVALID")
        val files = mutableListOf<FileSpec>()
        val paths = mutableSetOf<String>()
        val folded = mutableSetOf<String>()
        for (index in 0 until filesValue.length()) {
            val file = filesValue.opt(index) as? JSONObject ?: throw IllegalArgumentException("MANIFEST_INVALID")
            requireExactKeys(file, FILE_KEYS, "MANIFEST_INVALID")
            val path = exactString(file, "path") ?: throw IllegalArgumentException("MANIFEST_INVALID")
            val byteCount = MainaModelPackLifecyclePolicy.exactPositiveSafeLong(file.opt("byteCount"))
                ?: throw IllegalArgumentException("MANIFEST_INVALID")
            val chunkSize = MainaModelPackLifecyclePolicy.exactPositiveSafeLong(file.opt("chunkSizeBytes"))
                ?: throw IllegalArgumentException("MANIFEST_INVALID")
            val fileSha256 = exactString(file, "sha256") ?: throw IllegalArgumentException("MANIFEST_INVALID")
            val chunks = file.opt("chunkSha256") as? JSONArray ?: throw IllegalArgumentException("MANIFEST_INVALID")
            val chunkHashes = (0 until chunks.length()).map { chunks.opt(it) as? String ?: throw IllegalArgumentException("MANIFEST_INVALID") }
            if (!safeRelativePath(path) || !validSha(fileSha256) ||
                chunkHashes.size.toLong() != ((byteCount - 1L) / chunkSize) + 1L || chunkHashes.any { !validSha(it) } ||
                !paths.add(path) || !folded.add(path.lowercase())
            ) throw IllegalArgumentException("MANIFEST_PATH_INVALID")
            files += FileSpec(path, byteCount, fileSha256, chunkSize, chunkHashes)
        }
        if (files.size != REQUIRED_FILES.size || REQUIRED_FILES.any { (path, bytes) -> files.none { it.path == path && it.byteCount == bytes } }) {
            throw IllegalArgumentException("MANIFEST_FILE_SET_MISMATCH")
        }
        val platforms = raw.opt("platforms") as? JSONArray ?: throw IllegalArgumentException("MANIFEST_INVALID")
        if (platforms.length() != 2) throw IllegalArgumentException("PLATFORM_COMPATIBILITY_MISMATCH")
        var selected: PlatformSpec? = null
        val names = mutableSetOf<String>()
        for (index in 0 until platforms.length()) {
            val candidate = platforms.opt(index) as? JSONObject ?: throw IllegalArgumentException("MANIFEST_INVALID")
            requireExactKeys(candidate, PLATFORM_KEYS, "MANIFEST_INVALID")
            val name = exactString(candidate, "osFamily") ?: throw IllegalArgumentException("MANIFEST_INVALID")
            val minOsVersion = exactString(candidate, "minOsVersion") ?: throw IllegalArgumentException("MANIFEST_INVALID")
            val runtimeVersion = exactString(candidate, "runtimeVersion") ?: throw IllegalArgumentException("MANIFEST_INVALID")
            val runtimeSha256 = exactString(candidate, "runtimeSha256") ?: throw IllegalArgumentException("MANIFEST_INVALID")
            val smokeExpectedTextSha256 = exactString(candidate, "smokeExpectedTextSha256") ?: throw IllegalArgumentException("MANIFEST_INVALID")
            val architectures = candidate.opt("architectures") as? JSONArray ?: throw IllegalArgumentException("MANIFEST_INVALID")
            val architectureValues = (0 until architectures.length()).map {
                architectures.opt(it) as? String ?: throw IllegalArgumentException("MANIFEST_INVALID")
            }
            if (name !in setOf("android", "ios") || architectureValues.isEmpty() ||
                architectureValues.any { !validId(it) } || architectureValues.toSet().size != architectureValues.size ||
                !validVersion(minOsVersion) || !validId(runtimeVersion) ||
                !validSha(runtimeSha256) || !validSha(smokeExpectedTextSha256)
            ) throw IllegalArgumentException("MANIFEST_INVALID")
            names.add(name)
            if (name == PLATFORM) selected = PlatformSpec(
                minOsVersion, architectureValues, runtimeVersion, runtimeSha256, smokeExpectedTextSha256,
            )
        }
        if (names != setOf("android", "ios") || selected == null) throw IllegalArgumentException("PLATFORM_COMPATIBILITY_MISMATCH")
        val unsigned = JSONObject(raw.toString()).also { it.remove("manifestSha256") }
        if (sha256(canonicalJson(unsigned).toByteArray()) != manifestSha256) {
            throw IllegalArgumentException("MANIFEST_HASH_MISMATCH")
        }
        return Manifest(raw, packVersion, files, selected, smokeInputSha256, manifestSha256)
    }

    private fun readManifest(pack: File): Manifest? = runCatching { parseManifest(File(pack, "manifest.json").readText()) }.getOrNull()

    private fun requirePlatformCompatible(manifest: Manifest) {
        if (!platformCompatible() || !manifest.platform.architectures.contains("arm64-v8a") ||
            manifest.platform.runtimeVersion != RUNTIME_VERSION || manifest.platform.runtimeSha256 != RUNTIME_SHA256 ||
            MainaModelPackLifecyclePolicy.compareVersions(Build.VERSION.SDK_INT.toString(), manifest.platform.minOsVersion) < 0
        ) throw IllegalStateException("PLATFORM_COMPATIBILITY_MISMATCH")
    }

    private fun platformCompatible() = Build.VERSION.SDK_INT >= 26 && Build.SUPPORTED_ABIS.contains("arm64-v8a")

    private fun requireWriter(manifest: Manifest) {
        val writer = readExactJson(File(root, WRITER), WRITER_KEYS)
        if (writer?.optString("manifestSha256") != manifest.manifestSha256 || writer.optString("platform") != PLATFORM) {
            throw IllegalStateException("MODEL_PACK_WRITER_IDENTITY_MISMATCH")
        }
    }

    private fun requireRecord(manifest: Manifest, states: Set<String>): JSONObject {
        val record = readRecord(manifest.manifestSha256) ?: throw IllegalStateException("MODEL_PACK_RECORD_MISSING")
        if (record.optString("manifestSha256") != manifest.manifestSha256 || record.optString("packVersion") != manifest.packVersion ||
            record.optLong("bytesTotal") != manifest.bytesTotal || record.optString("platform") != PLATFORM || record.optString("state") !in states) {
            throw IllegalStateException("LIFECYCLE_TRANSITION_INVALID")
        }
        return record
    }

    private fun readRecord(manifestSha: String): JSONObject? {
        val record = readExactJson(recordFile(manifestSha), RECORD_KEYS) ?: return null
        val state = record.optString("state")
        val chunks = record.optJSONObject("verifiedChunks") ?: throw IllegalStateException("MODEL_PACK_RECORD_INVALID")
        if (record.optString("schemaVersion") != "maina.model-pack-lifecycle-record.v1" || record.optString("packId") != PACK_ID ||
            !validId(record.optString("packVersion")) || !validSha(record.optString("manifestSha256")) ||
            record.optString("platform") != PLATFORM || state !in LIFECYCLE_STATES || record.optLong("bytesTotal", -1L) <= 0L ||
            record.optLong("bytesComplete", -1L) !in 0L..record.optLong("bytesTotal") ||
            !validId(record.optString("reasonCode")) || chunks.keys().asSequence().any { !safeRelativePath(it) || it !in REQUIRED_FILES }
        ) throw IllegalStateException("MODEL_PACK_RECORD_INVALID")
        chunks.keys().asSequence().forEach { path ->
            val values = chunks.optJSONArray(path) ?: throw IllegalStateException("MODEL_PACK_RECORD_INVALID")
            if ((0 until values.length()).any { !validSha(values.optString(it)) }) throw IllegalStateException("MODEL_PACK_RECORD_INVALID")
        }
        return record
    }
    private fun recordFile(manifestSha: String) = File(File(root, "records"), "$manifestSha.json")
    private fun stagingDirectory(manifestSha: String) = File(File(root, "staging"), manifestSha)
    private fun packDirectory(manifestSha: String) = File(File(root, "packs"), manifestSha)

    private fun retainedRollbackBytes(): Long {
        val previous = readExactJson(File(root, READY_POINTER), POINTER_KEYS) ?: return 0L
        if (!validPointer(previous)) return 0L
        val manifest = readManifest(packDirectory(previous.optString("manifestSha256"))) ?: return 0L
        return manifest.bytesTotal
    }

    private fun rollbackIntent(
        failedManifestSha256: String,
        failedActivationGeneration: Long,
        previousReady: JSONObject?,
        ignoredReaderPinName: String,
    ): JSONObject = JSONObject()
        .put("schemaVersion", "maina.model-pack-open-rollback.v1")
        .put("failedManifestSha256", failedManifestSha256)
        .put("failedActivationGeneration", failedActivationGeneration)
        .put("ignoredReaderPinName", ignoredReaderPinName)
        .put("previousReady", previousReady ?: JSONObject.NULL)

    /**
     * Open failure rollback spans the active pointer, lifecycle record and
     * retained rollback pointer. The intent makes those individually atomic
     * writes replayable after every process-death cutpoint.
     */
    private fun reconcileOpenFailureRollback() {
        val intentFile = File(root, ROLLBACK_INTENT)
        val intent = readExactJson(intentFile, ROLLBACK_INTENT_KEYS) ?: return
        if (intent.optString("schemaVersion") != "maina.model-pack-open-rollback.v1" ||
            !validSha(intent.optString("failedManifestSha256")) ||
            intent.optLong("failedActivationGeneration", 0L) <= 0L
        ) throw IllegalStateException("MODEL_PACK_ROLLBACK_INTENT_INVALID")
        val failedManifestSha = intent.getString("failedManifestSha256")
        val failedGeneration = intent.getLong("failedActivationGeneration")
        val ignoredReaderPinName = intent.optString("ignoredReaderPinName")
        if (!validId(ignoredReaderPinName)) throw IllegalStateException("MODEL_PACK_ROLLBACK_INTENT_INVALID")
        val previous = if (intent.isNull("previousReady")) null else
            intent.optJSONObject("previousReady") ?: throw IllegalStateException("MODEL_PACK_ROLLBACK_INTENT_INVALID")
        if (previous != null) {
            requireExactKeys(previous, POINTER_KEYS, "MODEL_PACK_ROLLBACK_INTENT_INVALID")
            if (!validPointer(previous) || previous.optString("manifestSha256") == failedManifestSha) {
                throw IllegalStateException("MODEL_PACK_ROLLBACK_INTENT_INVALID")
            }
        }
        val failedManifest = readManifest(packDirectory(failedManifestSha))
            ?: throw IllegalStateException("MODEL_PACK_ROLLBACK_INTENT_INVALID")
        val failedRecord = readRecord(failedManifestSha)
            ?: throw IllegalStateException("MODEL_PACK_ROLLBACK_INTENT_INVALID")
        if (failedRecord.optString("manifestSha256") != failedManifestSha ||
            failedRecord.optLong("activationGeneration") != failedGeneration ||
            failedRecord.optString("state") !in setOf("ready", "rollback_pending", "failed_smoke")
        ) throw IllegalStateException("MODEL_PACK_ROLLBACK_INTENT_INVALID")

        // A result mapping is the durable first-success fence for this exact
        // activation. Older code or a crash interleaving may have persisted it
        // after the rollback intent; replay must never invalidate its record hash.
        if (hasExactResultFor(failedManifestSha, failedGeneration)) {
            if (!intentFile.delete()) throw IllegalStateException("MODEL_PACK_STORAGE_INVALID")
            directorySync(root)
            return
        }
        // The reader that discovered the open failure cannot veto its own
        // rollback request. Any other live reader may still be producing the
        // first exact result, so keep the durable intent and replay it when
        // that reader releases instead of losing the rollback permanently.
        if (hasActiveReadyReaders(failedManifestSha, ignoredReaderPinName)) return

        val ready = readExactJson(File(root, READY_POINTER), POINTER_KEYS)
        val readyIsFailed = ready != null && validPointer(ready) &&
            ready.optString("manifestSha256") == failedManifestSha &&
            ready.optLong("activationGeneration") == failedGeneration
        val readyIsPrevious = ready != null && previous != null && validPointer(ready) &&
            canonicalJson(ready) == canonicalJson(previous)
        if (ready != null && !readyIsFailed && !readyIsPrevious) {
            throw IllegalStateException("MODEL_PACK_ROLLBACK_INTENT_INVALID")
        }

        if (previous != null) {
            writeJsonAtomic(File(root, READY_POINTER), previous)
        } else if (File(root, READY_POINTER).exists()) {
            if (!File(root, READY_POINTER).delete()) throw IllegalStateException("MODEL_PACK_STORAGE_INVALID")
            directorySync(root)
        }
        if (failedRecord.optString("state") == "ready") {
            writeRecord(
                failedManifest, "rollback_pending", failedManifest.bytesTotal, "MODEL_OPEN_FAILED",
                completeProgress(failedManifest), failedGeneration,
            )
        }
        val refreshed = readRecord(failedManifestSha)
            ?: throw IllegalStateException("MODEL_PACK_ROLLBACK_INTENT_INVALID")
        if (refreshed.optString("state") == "rollback_pending") {
            writeRecord(
                failedManifest, "failed_smoke", failedManifest.bytesTotal, "MODEL_OPEN_FAILED_ROLLED_BACK",
                completeProgress(failedManifest), failedGeneration,
            )
        }
        val activeWriter = readExactJson(File(root, WRITER), WRITER_KEYS)
        if (activeWriter == null) {
            writeJsonAtomic(File(root, CURRENT_ACQUISITION), writerIdentity(failedManifestSha))
        } else {
            if (!validWriter(activeWriter)) throw IllegalStateException("MODEL_PACK_WRITER_IDENTITY_MISMATCH")
            val currentAcquisition = readExactJson(File(root, CURRENT_ACQUISITION), WRITER_KEYS)
            if (currentAcquisition == null || !sameWriter(activeWriter, currentAcquisition)) {
                throw IllegalStateException("MODEL_PACK_WRITER_IDENTITY_MISMATCH")
            }
        }
        if (File(root, PREVIOUS_POINTER).exists() && !File(root, PREVIOUS_POINTER).delete()) {
            throw IllegalStateException("MODEL_PACK_STORAGE_INVALID")
        }
        directorySync(root)
        if (!intentFile.delete()) throw IllegalStateException("MODEL_PACK_STORAGE_INVALID")
        directorySync(root)
    }

    private fun reconcileInterruptedPromotion() {
        val writer = readExactJson(File(root, WRITER), WRITER_KEYS) ?: return
        if (!validWriter(writer)) return
        val record = readRecord(writer.optString("manifestSha256")) ?: return
        val current = readExactJson(File(root, READY_POINTER), POINTER_KEYS)
        val currentMatches = current != null && validPointer(current) &&
            current.optString("manifestSha256") == writer.optString("manifestSha256") &&
            (record.optString("state") != "ready" || current.optLong("activationGeneration") == record.optLong("activationGeneration"))
        val previous = readExactJson(File(root, PREVIOUS_POINTER), POINTER_KEYS)
        val action = MainaModelPackLifecyclePolicy.interruptedPromotionAction(
            record.optString("state"), currentMatches, previous != null && validPointer(previous),
        )
        if (action == "complete_success_cleanup") {
            writeJsonAtomic(File(root, CURRENT_ACQUISITION), writer)
            if (!File(root, WRITER).delete()) throw IllegalStateException("MODEL_PACK_STORAGE_INVALID")
            directorySync(root)
            return
        }
        if (action == "none") return
        val manifest = readLifecycleManifest(writer.optString("manifestSha256")) ?: return
        if (action == "rollback_to_previous") {
            writeJsonAtomic(File(root, READY_POINTER), previous!!)
        } else if (action == "invalidate_first_activation") {
            if (File(root, READY_POINTER).exists() && !File(root, READY_POINTER).delete()) throw IllegalStateException("MODEL_PACK_STORAGE_INVALID")
            directorySync(root)
        }
        writeRecord(manifest, "failed_smoke", manifest.bytesTotal, "PROMOTION_INTERRUPTED_ROLLED_BACK", completeProgress(manifest), record.optLong("activationGeneration"))
        writeJsonAtomic(File(root, CURRENT_ACQUISITION), writer)
        if (!File(root, WRITER).delete()) throw IllegalStateException("MODEL_PACK_STORAGE_INVALID")
        directorySync(root)
    }

    private fun readLifecycleManifest(manifestSha: String): Manifest? {
        val packed = readManifest(packDirectory(manifestSha))
        val staged = readManifest(stagingDirectory(manifestSha))
        if (packed != null && staged != null && canonicalJson(packed.raw) != canonicalJson(staged.raw)) {
            throw IllegalStateException("MODEL_PACK_CURRENT_IDENTITY_INVALID")
        }
        return packed ?: staged
    }

    private fun writerIdentity(manifestSha: String) = JSONObject()
        .put("manifestSha256", manifestSha)
        .put("platform", PLATFORM)

    private fun validWriter(writer: JSONObject): Boolean =
        validSha(writer.optString("manifestSha256")) && writer.optString("platform") == PLATFORM

    private fun sameWriter(left: JSONObject, right: JSONObject): Boolean =
        left.optString("manifestSha256") == right.optString("manifestSha256") &&
            left.optString("platform") == right.optString("platform")

    private fun invalidLifecycleStatus(reason: String) =
        PublicStatus(null, "rollback_pending", 0, 0, reason, platformCompatible())

    private fun validPointer(pointer: JSONObject): Boolean = pointer.optString("packId") == PACK_ID &&
        validId(pointer.optString("packVersion")) && validSha(pointer.optString("manifestSha256")) &&
        pointer.optString("platform") == PLATFORM && pointer.optLong("activationGeneration", 0L) > 0L &&
        pointer.optString("runtimeVersion") == RUNTIME_VERSION

    private fun enumerateFiles(directory: File): List<String> {
        if (!directory.isDirectory || directory.canonicalFile != directory.absoluteFile) throw IllegalStateException("MANIFEST_PATH_INVALID")
        return directory.walkTopDown().filter { it != directory && it.isFile }.map { file ->
            if (!regularFile(file)) throw IllegalStateException("MANIFEST_PATH_INVALID")
            file.relativeTo(directory).invariantSeparatorsPath
        }.toList()
    }

    private fun deleteTreeNoFollow(directory: File) {
        val path = directory.toPath()
        Files.walk(path).use { stream ->
            stream.sorted(Comparator.reverseOrder()).forEach { entry -> Files.delete(entry) }
        }
    }

    private fun regularExactChild(directory: File, name: String): Boolean = regularFile(File(directory, name))
    private fun regularFile(file: File): Boolean = file.isFile && file.canonicalFile == file.absoluteFile

    private fun safeChild(parent: File, relative: String): File {
        if (!safeRelativePath(relative)) throw IllegalArgumentException("MANIFEST_PATH_INVALID")
        val child = File(parent, relative)
        val prefix = parent.canonicalPath + File.separator
        if (!child.canonicalPath.startsWith(prefix)) throw IllegalArgumentException("MANIFEST_PATH_INVALID")
        return child
    }

    private fun fileFromValue(value: String): File = when {
        value.startsWith("file:") -> File(java.net.URI(value))
        else -> File(value)
    }

    private fun writeJsonAtomic(target: File, value: JSONObject) {
        ensureDirectory(target.parentFile!!)
        val temporary = File(target.parentFile, ".${target.name}.${UUID.randomUUID()}.tmp")
        if (!temporary.createNewFile()) throw IllegalStateException("MODEL_PACK_ATOMIC_WRITE_FAILED")
        try {
            FileOutputStream(temporary).use { output ->
                output.write(canonicalJson(value).toByteArray(Charsets.UTF_8))
                output.fd.sync()
            }
            Files.move(
                temporary.toPath(),
                target.toPath(),
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING,
            )
            directorySync(target.parentFile!!)
        } finally {
            if (temporary.exists()) temporary.delete()
        }
    }

    private fun readExactJson(file: File, keys: Set<String>): JSONObject? {
        if (!file.exists()) return null
        if (!regularFile(file) || file.length() !in 2..1_000_000) throw IllegalStateException("MODEL_PACK_RECORD_INVALID")
        val value = runCatching { JSONObject(file.readText()) }.getOrElse { throw IllegalStateException("MODEL_PACK_RECORD_INVALID") }
        requireExactKeys(value, keys, "MODEL_PACK_RECORD_INVALID")
        return value
    }

    private fun <T> withWriterLock(action: () -> T): T {
        ensureDirectory(root)
        val lockFile = File(root, "writer.lock")
        FileOutputStream(lockFile, true).channel.use { channel ->
            channel.lock().use { return action() }
        }
    }

    private companion object {
        const val PACK_ID = "qwen3-asr-0.6b-int8"
        const val ENGINE_ID = "qwen3-0.6b-int8"
        const val LEGACY_MODEL_VERSION = "1"
        const val PLATFORM = "android"
        const val RUNTIME_VERSION = "sherpa-onnx-1.13.6"
        const val RUNTIME_SHA256 = "0012d9a28f15bd6fb966b62b70a75da3990512fdccce28b83098248ce4be1698"
        const val READY_POINTER = "ready.json"
        const val PREVIOUS_POINTER = "previous-ready.json"
        const val WRITER = "writer.json"
        const val CURRENT_ACQUISITION = "current.json"
        const val ROLLBACK_INTENT = "open-rollback.json"
        const val MAX_MANIFEST_CHARACTERS = 1_000_000
        val MANIFEST_KEYS = setOf("schemaVersion", "packId", "packVersion", "engineId", "formatVersion", "files", "platforms", "smokeInputSha256", "manifestSha256")
        val FILE_KEYS = setOf("path", "byteCount", "sha256", "chunkSizeBytes", "chunkSha256")
        val PLATFORM_KEYS = setOf("osFamily", "minOsVersion", "architectures", "runtimeVersion", "runtimeSha256", "smokeExpectedTextSha256")
        val POINTER_KEYS = setOf("packId", "packVersion", "manifestSha256", "platform", "activationGeneration", "runtimeVersion")
        val WRITER_KEYS = setOf("manifestSha256", "platform")
        val ROLLBACK_INTENT_KEYS = setOf("schemaVersion", "failedManifestSha256", "failedActivationGeneration", "ignoredReaderPinName", "previousReady")
        val RECORD_KEYS = setOf("schemaVersion", "packId", "packVersion", "manifestSha256", "platform", "activationGeneration", "state", "bytesComplete", "bytesTotal", "reasonCode", "verifiedChunks")
        val RESULT_KEYS = setOf("manifestSha256", "platform", "activationGeneration", "modelId", "modelVersion", "runtimeVersion", "lifecycleRecordSha256", "packRetained", "firstExactResultId", "firstExactResultSha256", "referencedResultIds")
        val PREPARED_RESULT_KEYS = setOf("schemaVersion", "manifestSha256", "activationGeneration", "modelId", "modelVersion", "runtimeVersion", "lifecycleRecordSha256", "resultId", "resultPayloadSha256")
        val LIFECYCLE_STATES = setOf("unavailable", "downloading", "verifying", "staged", "smoke_testing", "ready", "failed_download", "failed_verification", "failed_smoke", "rollback_pending")
        val REQUIRED_FILES = linkedMapOf(
            "conv_frontend.onnx" to 44_148_281L,
            "encoder.int8.onnx" to 182_491_662L,
            "decoder.int8.onnx" to 755_914_231L,
            "tokenizer/vocab.json" to 2_776_833L,
            "tokenizer/merges.txt" to 1_671_853L,
            "tokenizer/tokenizer_config.json" to 12_487L,
        )

        fun validSha(value: String) = value.matches(Regex("^[a-f0-9]{64}$"))
        fun validId(value: String) = value.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$"))
        fun validVersion(value: String) = value.length in 1..64 && value.matches(Regex("^[0-9]+(?:\\.[0-9]+){0,2}$"))
        fun safeRelativePath(value: String): Boolean = value.isNotBlank() && !value.startsWith("/") && !value.contains('\\') &&
            value.split('/').all { it.isNotBlank() && it != "." && it != ".." }

        fun requireExactKeys(value: JSONObject, expected: Set<String>, code: String) {
            val actual = value.keys().asSequence().toSet()
            if (actual != expected) throw IllegalArgumentException(code)
        }

        fun exactString(value: JSONObject, key: String): String? = value.opt(key) as? String

        fun canonicalJson(value: Any?): String = when (value) {
            null, JSONObject.NULL -> "null"
            is String -> JSONObject.quote(value)
            is Boolean -> if (value) "true" else "false"
            is Number -> {
                val long = value.toLong()
                if (value.toDouble() != long.toDouble()) throw IllegalArgumentException("MANIFEST_INVALID")
                long.toString()
            }
            is JSONArray -> (0 until value.length()).joinToString(prefix = "[", postfix = "]") { canonicalJson(value.get(it)) }
            is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(prefix = "{", postfix = "}") { key ->
                "${JSONObject.quote(key)}:${canonicalJson(value.get(key))}"
            }
            else -> throw IllegalArgumentException("MANIFEST_INVALID")
        }

        fun sha256(value: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(value).joinToString("") { "%02x".format(it) }
        fun sha256(file: File): String = FileInputStream(file).use { input ->
            val digest = MessageDigest.getInstance("SHA-256")
            val buffer = ByteArray(1024 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                if (count > 0) digest.update(buffer, 0, count)
            }
            digest.digest().joinToString("") { "%02x".format(it) }
        }

        fun chunkHashes(file: File, chunkSize: Long): List<String> = FileInputStream(file).use { input ->
            val result = mutableListOf<String>()
            val buffer = ByteArray(minOf(chunkSize, 1024L * 1024L).toInt())
            while (true) {
                val digest = MessageDigest.getInstance("SHA-256")
                var remaining = chunkSize
                var readAny = false
                while (remaining > 0L) {
                    val count = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
                    if (count < 0) break
                    if (count > 0) {
                        digest.update(buffer, 0, count)
                        remaining -= count
                        readAny = true
                    }
                }
                if (!readAny) break
                result += digest.digest().joinToString("") { "%02x".format(it) }
                if (remaining > 0L) break
            }
            result
        }

        fun ensureDirectory(directory: File) {
            if ((!directory.exists() && !directory.mkdirs()) || !directory.isDirectory || directory.canonicalFile != directory.absoluteFile) {
                throw IllegalStateException("MODEL_PACK_STORAGE_INVALID")
            }
        }

        fun fsyncDirectory(directory: File) {
            val descriptor = Os.open(directory.absolutePath, OsConstants.O_RDONLY, 0)
            try { Os.fsync(descriptor) } finally { Os.close(descriptor) }
        }
    }
}
