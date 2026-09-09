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
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.UUID

internal object MainaModelPackLifecyclePolicy {
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
    context: Context,
    private val root: File = File(context.filesDir, "maina-model-packs-v1"),
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
        private val pin: File,
    ) {
        fun release() {
            if (pin.exists() && !pin.delete()) throw IllegalStateException("MODEL_PACK_READER_RELEASE_FAILED")
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
        listOf("staging", "packs", "records", "readers", "results").forEach { ensureDirectory(File(root, it)) }
    }

    fun status(): PublicStatus = withWriterLock {
        val pointer = readExactJson(File(root, READY_POINTER), POINTER_KEYS) ?: return@withWriterLock PublicStatus(
            packVersion = null,
            state = "unavailable",
            bytesComplete = 0,
            bytesTotal = 0,
            reasonCode = "NONE",
            platformCompatible = platformCompatible(),
        )
        val manifestSha = pointer.optString("manifestSha256")
        val record = readRecord(manifestSha)
        val pack = packDirectory(manifestSha)
        if (record == null || record.optString("state") != "ready" || !pack.isDirectory || !regularExactChild(pack, "manifest.json")) {
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
        val manifest = parseManifest(manifestJson)
        requirePlatformCompatible(manifest)
        val writer = readExactJson(File(root, WRITER), WRITER_KEYS)
        if (writer != null && writer.optString("manifestSha256") != manifest.manifestSha256) {
            throw IllegalStateException("MODEL_PACK_WRITER_CONFLICT")
        }
        val rollbackBytes = retainedRollbackBytes()
        val required = MainaModelPackLifecyclePolicy.requiredSpace(
            manifest.bytesTotal,
            partialOverheadBytes,
            rollbackBytes,
            safetyMarginBytes,
        ) ?: throw IllegalArgumentException("STORAGE_PREFLIGHT_FAILED")
        if (root.usableSpace < required) throw IllegalStateException("STORAGE_PREFLIGHT_FAILED")

        writeJsonAtomic(File(root, WRITER), JSONObject().put("manifestSha256", manifest.manifestSha256).put("platform", PLATFORM))
        val stage = stagingDirectory(manifest.manifestSha256)
        ensureDirectory(stage)
        writeJsonAtomic(File(stage, "manifest.json"), manifest.raw)
        val previous = readRecord(manifest.manifestSha256)
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
        FileOutputStream(target, true).use { output ->
            FileInputStream(source).use { input -> input.copyTo(output) }
            output.fd.sync()
        }
        val next = progress.toMutableMap()
        next[relativePath] = completed + spec.chunkSha256[chunkIndex]
        val bytes = verifiedBytes(next, manifest)
        writeRecord(manifest, "downloading", bytes, "NONE", next)
        public(manifest, "downloading", bytes, "NONE")
    }

    fun verifyStaged(manifestJson: String): PublicStatus = withWriterLock {
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
        val manifest = parseManifest(manifestJson)
        requireWriter(manifest)
        requireRecord(manifest, setOf("staged"))
        stagingDirectory(manifest.manifestSha256)
    }

    fun promote(manifestJson: String, evidence: SmokeEvidence): PublicStatus = withWriterLock {
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
        val oldSha = oldReady?.optString("manifestSha256")?.takeIf(::validSha)
        val destination = packDirectory(manifest.manifestSha256)
        val stage = stagingDirectory(manifest.manifestSha256)
        if (destination.exists() || !stage.renameTo(destination)) {
            fail(manifest, "failed_smoke", "PROMOTION_ATOMICITY_FAILED", completeProgress(manifest))
            throw IllegalStateException("PROMOTION_ATOMICITY_FAILED")
        }
        fsyncDirectory(File(root, "packs"))
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
        fsyncDirectory(root)
        public(manifest, "ready", manifest.bytesTotal, "NONE")
    }

    fun acquireReady(): ReadyHandle? = withWriterLock {
        val pointer = readExactJson(File(root, READY_POINTER), POINTER_KEYS) ?: return@withWriterLock null
        val manifestSha = pointer.optString("manifestSha256")
        val record = readRecord(manifestSha) ?: return@withWriterLock null
        if (record.optString("state") != "ready") return@withWriterLock null
        val pack = packDirectory(manifestSha)
        if (!pack.isDirectory) return@withWriterLock null
        val pinRoot = File(File(root, "readers"), manifestSha)
        ensureDirectory(pinRoot)
        val pin = File(pinRoot, UUID.randomUUID().toString())
        if (!pin.createNewFile()) throw IllegalStateException("MODEL_PACK_READER_PIN_FAILED")
        FileOutputStream(pin).use { output ->
            output.write("generation=${pointer.getLong("activationGeneration")}\n".toByteArray())
            output.fd.sync()
        }
        ReadyHandle(
            root = pack,
            packVersion = pointer.getString("packVersion"),
            manifestSha256 = manifestSha,
            activationGeneration = pointer.getLong("activationGeneration"),
            runtimeVersion = pointer.getString("runtimeVersion"),
            pin = pin,
        )
    }

    fun rollbackAfterOpenFailure(handle: ReadyHandle): Boolean = withWriterLock {
        val current = readExactJson(File(root, READY_POINTER), POINTER_KEYS) ?: return@withWriterLock false
        if (current.optString("manifestSha256") != handle.manifestSha256 ||
            current.optLong("activationGeneration") != handle.activationGeneration
        ) return@withWriterLock false
        val previous = readExactJson(File(root, PREVIOUS_POINTER), POINTER_KEYS) ?: return@withWriterLock false
        val currentManifest = readManifest(packDirectory(handle.manifestSha256)) ?: return@withWriterLock false
        writeRecord(currentManifest, "rollback_pending", currentManifest.bytesTotal, "MODEL_OPEN_FAILED", completeProgress(currentManifest), handle.activationGeneration)
        writeJsonAtomic(File(root, READY_POINTER), previous)
        writeRecord(currentManifest, "failed_smoke", currentManifest.bytesTotal, "MODEL_OPEN_FAILED_ROLLED_BACK", completeProgress(currentManifest), handle.activationGeneration)
        File(root, PREVIOUS_POINTER).delete()
        fsyncDirectory(root)
        true
    }

    fun noteExactResult(handle: ReadyHandle, resultId: String, resultPayloadSha256: String): Boolean = withWriterLock {
        if (!validId(resultId) || !validSha(resultPayloadSha256)) return@withWriterLock false
        val mapping = File(File(root, "results"), "${handle.manifestSha256}-${handle.activationGeneration}.json")
        val existing = readExactJson(mapping, RESULT_KEYS)
        val ids = existing?.getJSONArray("referencedResultIds") ?: JSONArray()
        if ((0 until ids.length()).none { ids.optString(it) == resultId }) ids.put(resultId)
        val first = existing?.optString("firstExactResultId")?.takeIf { it.isNotEmpty() } ?: resultId
        val firstSha = existing?.optString("firstExactResultSha256")?.takeIf { it.isNotEmpty() } ?: resultPayloadSha256
        writeJsonAtomic(mapping, JSONObject()
            .put("manifestSha256", handle.manifestSha256)
            .put("platform", PLATFORM)
            .put("activationGeneration", handle.activationGeneration)
            .put("modelId", PACK_ID)
            .put("modelVersion", handle.packVersion)
            .put("runtimeVersion", handle.runtimeVersion)
            .put("firstExactResultId", first)
            .put("firstExactResultSha256", firstSha)
            .put("referencedResultIds", ids))
        true
    }

    private data class Progress(val bytes: Long, val chunks: Map<String, List<String>>)

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
        writeRecord(manifest, state, verifiedBytes(progress, manifest), reason, progress)
        File(root, WRITER).delete()
        fsyncDirectory(root)
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
        val raw = runCatching { JSONObject(value) }.getOrElse { throw IllegalArgumentException("MANIFEST_INVALID") }
        requireExactKeys(raw, MANIFEST_KEYS, "MANIFEST_INVALID")
        if (raw.optString("schemaVersion") != "maina.model-pack-manifest.v1" || raw.optString("packId") != PACK_ID ||
            raw.optString("engineId") != PACK_ID || raw.optString("formatVersion") != "1" ||
            !validId(raw.optString("packVersion")) || !validSha(raw.optString("smokeInputSha256")) ||
            !validSha(raw.optString("manifestSha256"))
        ) throw IllegalArgumentException("MANIFEST_INVALID")
        val filesValue = raw.optJSONArray("files") ?: throw IllegalArgumentException("MANIFEST_INVALID")
        val files = mutableListOf<FileSpec>()
        val paths = mutableSetOf<String>()
        val folded = mutableSetOf<String>()
        for (index in 0 until filesValue.length()) {
            val file = filesValue.optJSONObject(index) ?: throw IllegalArgumentException("MANIFEST_INVALID")
            requireExactKeys(file, FILE_KEYS, "MANIFEST_INVALID")
            val path = file.optString("path")
            val byteCount = file.optLong("byteCount", -1L)
            val chunkSize = file.optLong("chunkSizeBytes", -1L)
            val chunks = file.optJSONArray("chunkSha256") ?: throw IllegalArgumentException("MANIFEST_INVALID")
            val chunkHashes = (0 until chunks.length()).map { chunks.optString(it) }
            if (!safeRelativePath(path) || byteCount <= 0L || chunkSize <= 0L || !validSha(file.optString("sha256")) ||
                chunkHashes.size.toLong() != (byteCount + chunkSize - 1L) / chunkSize || chunkHashes.any { !validSha(it) } ||
                !paths.add(path) || !folded.add(path.lowercase())
            ) throw IllegalArgumentException("MANIFEST_PATH_INVALID")
            files += FileSpec(path, byteCount, file.getString("sha256"), chunkSize, chunkHashes)
        }
        if (files.size != REQUIRED_FILES.size || REQUIRED_FILES.any { (path, bytes) -> files.none { it.path == path && it.byteCount == bytes } }) {
            throw IllegalArgumentException("MANIFEST_FILE_SET_MISMATCH")
        }
        val platforms = raw.optJSONArray("platforms") ?: throw IllegalArgumentException("MANIFEST_INVALID")
        if (platforms.length() != 2) throw IllegalArgumentException("PLATFORM_COMPATIBILITY_MISMATCH")
        var selected: PlatformSpec? = null
        val names = mutableSetOf<String>()
        for (index in 0 until platforms.length()) {
            val candidate = platforms.optJSONObject(index) ?: throw IllegalArgumentException("MANIFEST_INVALID")
            requireExactKeys(candidate, PLATFORM_KEYS, "MANIFEST_INVALID")
            val name = candidate.optString("osFamily")
            val architectures = candidate.optJSONArray("architectures") ?: throw IllegalArgumentException("MANIFEST_INVALID")
            val architectureValues = (0 until architectures.length()).map { architectures.optString(it) }
            if (name !in setOf("android", "ios") || !names.add(name) || architectureValues.isEmpty() ||
                architectureValues.any { !validId(it) } || architectureValues.toSet().size != architectureValues.size ||
                !validVersion(candidate.optString("minOsVersion")) || !validId(candidate.optString("runtimeVersion")) ||
                !validSha(candidate.optString("runtimeSha256")) || !validSha(candidate.optString("smokeExpectedTextSha256"))
            ) throw IllegalArgumentException("MANIFEST_INVALID")
            if (name == PLATFORM) selected = PlatformSpec(
                candidate.getString("minOsVersion"), architectureValues, candidate.getString("runtimeVersion"),
                candidate.getString("runtimeSha256"), candidate.getString("smokeExpectedTextSha256"),
            )
        }
        if (names != setOf("android", "ios") || selected == null) throw IllegalArgumentException("PLATFORM_COMPATIBILITY_MISMATCH")
        val unsigned = JSONObject(raw.toString()).also { it.remove("manifestSha256") }
        if (sha256(canonicalJson(unsigned).toByteArray()) != raw.getString("manifestSha256")) {
            throw IllegalArgumentException("MANIFEST_HASH_MISMATCH")
        }
        return Manifest(raw, raw.getString("packVersion"), files, selected, raw.getString("smokeInputSha256"), raw.getString("manifestSha256"))
    }

    private fun readManifest(pack: File): Manifest? = runCatching { parseManifest(File(pack, "manifest.json").readText()) }.getOrNull()

    private fun requirePlatformCompatible(manifest: Manifest) {
        if (!platformCompatible() || !manifest.platform.architectures.contains("arm64-v8a") ||
            manifest.platform.runtimeVersion != RUNTIME_VERSION || manifest.platform.runtimeSha256 != RUNTIME_SHA256 ||
            compareVersions(Build.VERSION.SDK_INT.toString(), manifest.platform.minOsVersion) < 0
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
        if (record.optString("manifestSha256") != manifest.manifestSha256 || record.optString("platform") != PLATFORM || record.optString("state") !in states) {
            throw IllegalStateException("LIFECYCLE_TRANSITION_INVALID")
        }
        return record
    }

    private fun readRecord(manifestSha: String) = readExactJson(recordFile(manifestSha), RECORD_KEYS)
    private fun recordFile(manifestSha: String) = File(File(root, "records"), "$manifestSha.json")
    private fun stagingDirectory(manifestSha: String) = File(File(root, "staging"), manifestSha)
    private fun packDirectory(manifestSha: String) = File(File(root, "packs"), manifestSha)

    private fun retainedRollbackBytes(): Long {
        val previous = readExactJson(File(root, PREVIOUS_POINTER), POINTER_KEYS) ?: return 0L
        val manifest = readManifest(packDirectory(previous.optString("manifestSha256"))) ?: return 0L
        return manifest.bytesTotal
    }

    private fun enumerateFiles(directory: File): List<String> {
        if (!directory.isDirectory || directory.canonicalFile != directory.absoluteFile) throw IllegalStateException("MANIFEST_PATH_INVALID")
        return directory.walkTopDown().filter { it != directory && it.isFile }.map { file ->
            if (!regularFile(file)) throw IllegalStateException("MANIFEST_PATH_INVALID")
            file.relativeTo(directory).invariantSeparatorsPath
        }.toList()
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
            fsyncDirectory(target.parentFile!!)
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
        const val PLATFORM = "android"
        const val RUNTIME_VERSION = "sherpa-onnx-1.13.6"
        const val RUNTIME_SHA256 = "0012d9a28f15bd6fb966b62b70a75da3990512fdccce28b83098248ce4be1698"
        const val READY_POINTER = "ready.json"
        const val PREVIOUS_POINTER = "previous-ready.json"
        const val WRITER = "writer.json"
        val MANIFEST_KEYS = setOf("schemaVersion", "packId", "packVersion", "engineId", "formatVersion", "files", "platforms", "smokeInputSha256", "manifestSha256")
        val FILE_KEYS = setOf("path", "byteCount", "sha256", "chunkSizeBytes", "chunkSha256")
        val PLATFORM_KEYS = setOf("osFamily", "minOsVersion", "architectures", "runtimeVersion", "runtimeSha256", "smokeExpectedTextSha256")
        val POINTER_KEYS = setOf("packId", "packVersion", "manifestSha256", "platform", "activationGeneration", "runtimeVersion")
        val WRITER_KEYS = setOf("manifestSha256", "platform")
        val RECORD_KEYS = setOf("schemaVersion", "packId", "packVersion", "manifestSha256", "platform", "activationGeneration", "state", "bytesComplete", "bytesTotal", "reasonCode", "verifiedChunks")
        val RESULT_KEYS = setOf("manifestSha256", "platform", "activationGeneration", "modelId", "modelVersion", "runtimeVersion", "firstExactResultId", "firstExactResultSha256", "referencedResultIds")
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
        fun validVersion(value: String) = value.matches(Regex("^[0-9]+(?:\\.[0-9]+){0,2}$"))
        fun safeRelativePath(value: String): Boolean = value.isNotBlank() && !value.startsWith("/") && !value.contains('\\') &&
            value.split('/').all { it.isNotBlank() && it != "." && it != ".." }

        fun requireExactKeys(value: JSONObject, expected: Set<String>, code: String) {
            val actual = value.keys().asSequence().toSet()
            if (actual != expected) throw IllegalArgumentException(code)
        }

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

        fun compareVersions(left: String, right: String): Int {
            val a = left.split('.').mapNotNull(String::toIntOrNull)
            val b = right.split('.').mapNotNull(String::toIntOrNull)
            for (index in 0 until maxOf(a.size, b.size)) {
                val compared = (a.getOrNull(index) ?: 0).compareTo(b.getOrNull(index) ?: 0)
                if (compared != 0) return compared
            }
            return 0
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
