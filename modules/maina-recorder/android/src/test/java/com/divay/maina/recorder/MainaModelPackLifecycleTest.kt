package com.divay.maina.recorder

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.json.JSONArray
import org.json.JSONObject
import java.nio.file.Files
import java.security.MessageDigest

class MainaModelPackLifecycleTest {
    @Test
    fun `permits only the frozen lifecycle transitions`() {
        assertTrue(MainaModelPackLifecyclePolicy.transitionAllowed(
            "downloading", "verifying", "all_declared_bytes_present",
        ))
        assertTrue(MainaModelPackLifecyclePolicy.transitionAllowed(
            "smoke_testing", "ready", "smoke_receipt_and_atomic_pointer_durable",
        ))
        assertFalse(MainaModelPackLifecyclePolicy.transitionAllowed(
            "downloading", "staged", "all_declared_bytes_present",
        ))
        assertFalse(MainaModelPackLifecyclePolicy.transitionAllowed(
            "staged", "ready", "smoke_receipt_and_atomic_pointer_durable",
        ))
    }

    @Test
    fun `resumes only the exact manifest platform file and verified prefix`() {
        val declared = listOf("a".repeat(64), "b".repeat(64), "c".repeat(64))
        assertEquals(2, MainaModelPackLifecyclePolicy.resumePrefix(
            "1".repeat(64), "1".repeat(64), "encoder.int8.onnx", "encoder.int8.onnx",
            30, 30, "android", "android", declared.take(2), declared.take(2), declared,
        ))
        assertNull(MainaModelPackLifecyclePolicy.resumePrefix(
            "1".repeat(64), "2".repeat(64), "encoder.int8.onnx", "encoder.int8.onnx",
            30, 30, "android", "android", declared.take(2), declared.take(2), declared,
        ))
        assertNull(MainaModelPackLifecyclePolicy.resumePrefix(
            "1".repeat(64), "1".repeat(64), "encoder.int8.onnx", "encoder.int8.onnx",
            30, 30, "android", "android", listOf("9".repeat(64)), listOf("9".repeat(64)), declared,
        ))
    }

    @Test
    fun `storage formula retains active rollback partial overhead and margin`() {
        assertEquals(220L, MainaModelPackLifecyclePolicy.requiredSpace(100, 10, 100, 10))
        assertNull(MainaModelPackLifecyclePolicy.requiredSpace(100, -1, 100, 10))
        assertNull(MainaModelPackLifecyclePolicy.requiredSpace(Long.MAX_VALUE, 1, 0, 0))
    }

    @Test
    fun `manifest parsing rejects json scalar coercion and oversized versions`() {
        val variants = listOf<(JSONObject) -> Unit>(
            { it.put("packVersion", 1) },
            { it.getJSONArray("files").getJSONObject(0).put("byteCount", "44148281") },
            { it.getJSONArray("files").getJSONObject(0).put("chunkSizeBytes", 9_007_199_254_740_992L) },
            { it.getJSONArray("files").getJSONObject(0).put("chunkSha256", JSONArray().put(1)) },
            { it.getJSONArray("platforms").getJSONObject(0).put("osFamily", JSONObject().put("value", "android")) },
            { it.getJSONArray("platforms").getJSONObject(0).put("minOsVersion", 26) },
            { it.getJSONArray("platforms").getJSONObject(0).put("architectures", JSONArray().put(64)) },
            { it.put("platforms", JSONObject().put("0", it.getJSONArray("platforms").getJSONObject(0))) },
            { it.put("platforms", JSONArray().put(JSONObject.NULL).put(platform("ios", "17.0", "arm64", "sherpa-onnx-1.13.4-ios-no-tts", "d8baaa925248e8e8ad23870208cdaf3d093623e6733aede2c23862f30c5aac62", "b".repeat(64)))) },
            { it.getJSONArray("platforms").getJSONObject(0).put("minOsVersion", "9".repeat(65)) },
        )
        for (mutate in variants) {
            val root = Files.createTempDirectory("maina-model-pack-strict-manifest").toFile().canonicalFile
            try {
                val manifest = syntheticManifest()
                mutate(manifest)
                rehashManifest(manifest)
                val failure = assertThrows(IllegalArgumentException::class.java) {
                    MainaModelPackLifecycle(root = root, directorySync = {}).begin(manifest.toString(), 0, 0)
                }
                assertEquals("MANIFEST_INVALID", failure.message)
                assertFalse(root.resolve("writer.json").exists())
            } finally {
                root.deleteRecursively()
            }
        }
    }

    @Test
    fun `version comparison uses the bounded ascii grammar without integer narrowing`() {
        val comparisons = listOf(
            Triple("17", "17", 0),
            Triple("17.0", "17", 0),
            Triple("17.0.0", "17.0", 0),
            Triple("17.0.1", "17.0", 1),
            Triple("18", "17.99999999999999999999999999999999", 1),
            Triple("00017.00", "17.0.0", 0),
            Triple("17", "99999999999999999999999999999999", -1),
            Triple("17.1", "17.99999999999999999999999999999999", -1),
            Triple("17.1.1", "17.1.99999999999999999999999999999999", -1),
        )
        for ((left, right, expected) in comparisons) {
            assertEquals(expected, MainaModelPackLifecyclePolicy.compareVersions(left, right))
        }
        assertEquals(0, MainaModelPackLifecyclePolicy.compareVersions("1.${"0".repeat(62)}", "1"))
        for (invalid in listOf(
            "", "17.", ".17", "17..0", "17.0.0.0", "-17", "+17", " 17", "17 ", "17\n",
            "１７", "١٧", "9".repeat(65),
        )) {
            val failure = assertThrows(IllegalArgumentException::class.java) {
                MainaModelPackLifecyclePolicy.compareVersions("36", invalid)
            }
            assertEquals("MANIFEST_INVALID", failure.message)
        }
    }

    @Test
    fun `platform structure and platform identity use stable distinct reasons before writes`() {
        fun assertRejected(expected: String, platforms: Any) {
            val root = Files.createTempDirectory("maina-model-pack-platform-reason").toFile().canonicalFile
            try {
                val manifest = syntheticManifest().put("platforms", platforms)
                rehashManifest(manifest)
                val failure = assertThrows(IllegalArgumentException::class.java) {
                    MainaModelPackLifecycle(root = root, directorySync = {}).begin(manifest.toString(), 0, 0)
                }
                assertEquals(expected, failure.message)
                assertFalse(root.resolve("writer.json").exists())
                assertFalse(root.resolve("current.json").exists())
                assertTrue(root.resolve("staging").listFiles()?.isEmpty() == true)
            } finally {
                root.deleteRecursively()
            }
        }

        val android = platform("android", "26", "arm64-v8a", "sherpa-onnx-1.13.6", "0012d9a28f15bd6fb966b62b70a75da3990512fdccce28b83098248ce4be1698", "a".repeat(64))
        val ios = platform("ios", "17.0", "arm64", "sherpa-onnx-1.13.4-ios-no-tts", "d8baaa925248e8e8ad23870208cdaf3d093623e6733aede2c23862f30c5aac62", "b".repeat(64))
        for (platforms in listOf(
            JSONArray(),
            JSONArray().put(android),
            JSONArray().put(android).put(android),
            JSONArray().put(android).put(ios).put(ios),
        )) assertRejected("PLATFORM_COMPATIBILITY_MISMATCH", platforms)

        assertRejected("MANIFEST_INVALID", JSONObject().put("0", android))
        assertRejected("MANIFEST_INVALID", JSONArray().put(JSONObject.NULL))
        assertRejected("MANIFEST_INVALID", JSONArray().put(JSONObject.NULL).put(ios))
        assertRejected("MANIFEST_INVALID", JSONArray().put(android).put(JSONObject.NULL).put(ios))
        assertRejected("MANIFEST_INVALID", JSONArray().put(JSONObject(android.toString()).put("osFamily", "windows")).put(ios))
        assertRejected("MANIFEST_INVALID", JSONArray().put(JSONObject(android.toString()).put("minOsVersion", 26)).put(ios))
        assertRejected("MANIFEST_INVALID", JSONArray().put(JSONObject(android.toString()).put("architectures", JSONArray().put("arm64-v8a").put(64))).put(ios))
    }

    @Test
    fun `integral json numbers remain valid without string coercion`() {
        assertEquals(44_148_281L, MainaModelPackLifecyclePolicy.exactPositiveSafeLong(44_148_281))
        assertEquals(44_148_281L, MainaModelPackLifecyclePolicy.exactPositiveSafeLong(44_148_281L))
        assertEquals(44_148_281L, MainaModelPackLifecyclePolicy.exactPositiveSafeLong(44_148_281.0))
        assertNull(MainaModelPackLifecyclePolicy.exactPositiveSafeLong("44148281"))
        assertNull(MainaModelPackLifecyclePolicy.exactPositiveSafeLong(44_148_281.5))
        assertNull(MainaModelPackLifecyclePolicy.exactPositiveSafeLong(9_007_199_254_740_992L))
    }

    @Test
    fun `promotion fails before every exact prerequisite is durable`() {
        assertTrue(MainaModelPackLifecyclePolicy.promotionAllowed(
            manifestVerified = true,
            platformCompatible = true,
            smokePassed = true,
            previousReadyRetained = true,
            conflictingWriter = false,
            stagedDurable = true,
        ))
        assertFalse(MainaModelPackLifecyclePolicy.promotionAllowed(false, true, true, true, false, true))
        assertFalse(MainaModelPackLifecyclePolicy.promotionAllowed(true, true, false, true, false, true))
        assertFalse(MainaModelPackLifecyclePolicy.promotionAllowed(true, true, true, false, false, true))
        assertFalse(MainaModelPackLifecyclePolicy.promotionAllowed(true, true, true, true, true, true))
        assertFalse(MainaModelPackLifecyclePolicy.promotionAllowed(true, true, true, true, false, false))
    }

    @Test
    fun `cleanup stays closed around readers results rollback and in-progress packs`() {
        assertTrue(MainaModelPackLifecyclePolicy.cleanupAllowed(
            targetActive = false,
            rollbackRetained = false,
            inProgress = false,
            pinnedReaders = 0,
            resultReferences = 0,
            exactSuccessorResult = true,
        ))
        assertFalse(MainaModelPackLifecyclePolicy.cleanupAllowed(true, false, false, 0, 0, true))
        assertFalse(MainaModelPackLifecyclePolicy.cleanupAllowed(false, true, false, 0, 0, true))
        assertFalse(MainaModelPackLifecyclePolicy.cleanupAllowed(false, false, true, 0, 0, true))
        assertFalse(MainaModelPackLifecyclePolicy.cleanupAllowed(false, false, false, 1, 0, true))
        assertFalse(MainaModelPackLifecyclePolicy.cleanupAllowed(false, false, false, 0, 1, true))
        assertFalse(MainaModelPackLifecyclePolicy.cleanupAllowed(false, false, false, 0, 0, false))
    }

    @Test
    fun `interrupted promotion reconciles without guessing success`() {
        assertEquals("complete_success_cleanup", MainaModelPackLifecyclePolicy.interruptedPromotionAction(
            "ready", readyPointsToWriter = true, previousPointerValid = true,
        ))
        assertEquals("rollback_to_previous", MainaModelPackLifecyclePolicy.interruptedPromotionAction(
            "smoke_testing", readyPointsToWriter = true, previousPointerValid = true,
        ))
        assertEquals("invalidate_first_activation", MainaModelPackLifecyclePolicy.interruptedPromotionAction(
            "smoke_testing", readyPointsToWriter = true, previousPointerValid = false,
        ))
        assertEquals("mark_failed_preserve_current", MainaModelPackLifecyclePolicy.interruptedPromotionAction(
            "smoke_testing", readyPointsToWriter = false, previousPointerValid = true,
        ))
    }

    @Test
    fun `pre rename smoke crash is reconciled from verified staging and clears writer`() {
        val root = Files.createTempDirectory("maina-model-pack-android-crash").toFile().canonicalFile
        try {
            val manifest = syntheticManifest()
            val manifestSha = manifest.getString("manifestSha256")
            val stage = root.resolve("staging/$manifestSha").apply { mkdirs() }
            stage.resolve("manifest.json").writeText(manifest.toString())
            root.resolve("writer.json").writeText(writer(manifestSha).toString())
            root.resolve("current.json").writeText(writer(manifestSha).toString())
            root.resolve("records/$manifestSha.json").apply {
                parentFile!!.mkdirs()
                writeText(record(manifest, "smoke_testing", "NONE").toString())
            }

            val status = MainaModelPackLifecycle(root = root, directorySync = {}).status()

            assertEquals("failed_smoke", status.state)
            assertEquals("PROMOTION_INTERRUPTED_ROLLED_BACK", status.reasonCode)
            assertFalse(root.resolve("writer.json").exists())
            assertTrue(root.resolve("current.json").isFile)
            assertTrue(stage.resolve("manifest.json").isFile)
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `status exposes durable acquisition and terminal failure without ready pointer`() {
        val root = Files.createTempDirectory("maina-model-pack-android-status").toFile().canonicalFile
        try {
            val manifest = syntheticManifest()
            val manifestSha = manifest.getString("manifestSha256")
            root.resolve("staging/$manifestSha").apply {
                mkdirs()
                resolve("manifest.json").writeText(manifest.toString())
            }
            root.resolve("writer.json").writeText(writer(manifestSha).toString())
            root.resolve("current.json").writeText(writer(manifestSha).toString())
            val recordFile = root.resolve("records/$manifestSha.json").apply { parentFile!!.mkdirs() }
            recordFile.writeText(record(manifest, "downloading", "NONE").toString())

            val lifecycle = MainaModelPackLifecycle(root = root, directorySync = {})
            assertEquals("downloading", lifecycle.status().state)

            assertTrue(root.resolve("writer.json").delete())
            recordFile.writeText(record(manifest, "failed_download", "DOWNLOAD_WRITE_FAILED").toString())
            val failed = MainaModelPackLifecycle(root = root).status()
            assertEquals("failed_download", failed.state)
            assertEquals("DOWNLOAD_WRITE_FAILED", failed.reasonCode)
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `terminal result stays bound to recorded generation after ready pointer moves`() {
        val root = Files.createTempDirectory("maina-model-pack-android-result").toFile().canonicalFile
        try {
            val original = syntheticManifest(packVersion = "same-version", hashCharacter = 'a')
            val successor = syntheticManifest(packVersion = "same-version", hashCharacter = 'b')
            listOf(original to 1L, successor to 2L).forEach { (manifest, generation) ->
                val sha = manifest.getString("manifestSha256")
                root.resolve("packs/$sha").apply {
                    mkdirs()
                    resolve("manifest.json").writeText(manifest.toString())
                }
                root.resolve("records/$sha.json").apply {
                    parentFile!!.mkdirs()
                    writeText(record(manifest, "ready", "NONE", generation).toString())
                }
            }
            root.resolve("ready.json").writeText(pointer(successor, 2L).toString())
            root.resolve("current.json").writeText(writer(successor.getString("manifestSha256")).toString())
            val lifecycle = MainaModelPackLifecycle(root = root, directorySync = {})
            val payloadSha = lifecycle.resultPayloadSha256(mapOf("runId" to "run-1", "state" to "complete"))
            val resultId = lifecycle.resultIdForPayloadSha256(payloadSha)!!

            assertTrue(lifecycle.noteExactResult(
                modelId = "qwen3-0.6b-int8",
                modelVersion = "same-version",
                runtimeVersion = "sherpa-onnx-1.13.6",
                manifestSha256 = original.getString("manifestSha256"),
                activationGeneration = 1L,
                resultId = resultId,
                resultPayloadSha256 = payloadSha,
            ))
            val successorPayloadSha = lifecycle.resultPayloadSha256(mapOf("runId" to "run-2", "state" to "complete"))
            val successorResultId = lifecycle.resultIdForPayloadSha256(successorPayloadSha)!!
            assertFalse(lifecycle.noteExactResult(
                modelId = "qwen3-0.6b-int8",
                modelVersion = "same-version",
                runtimeVersion = "sherpa-onnx-1.13.6",
                manifestSha256 = successor.getString("manifestSha256"),
                activationGeneration = 2L,
                resultId = successorResultId,
                resultPayloadSha256 = successorPayloadSha,
            ))
            assertFalse(lifecycle.noteExactResult(
                modelId = "qwen3-0.6b-int8",
                modelVersion = "same-version",
                runtimeVersion = "sherpa-onnx-1.13.6",
                manifestSha256 = successor.getString("manifestSha256"),
                activationGeneration = 2L,
                resultId = resultId,
                resultPayloadSha256 = payloadSha,
            ))
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `legacy result remains valid while an unrelated acquisition is failed`() {
        val root = Files.createTempDirectory("maina-model-pack-android-legacy-result").toFile().canonicalFile
        try {
            val manifest = syntheticManifest()
            val manifestSha = manifest.getString("manifestSha256")
            root.resolve("staging/$manifestSha").apply {
                mkdirs()
                resolve("manifest.json").writeText(manifest.toString())
            }
            root.resolve("current.json").writeText(writer(manifestSha).toString())
            root.resolve("records/$manifestSha.json").apply {
                parentFile!!.mkdirs()
                writeText(record(manifest, "failed_download", "DOWNLOAD_WRITE_FAILED").toString())
            }
            val lifecycle = MainaModelPackLifecycle(root = root, directorySync = {})
            val payloadSha = lifecycle.resultPayloadSha256(mapOf("runId" to "legacy-run", "state" to "complete"))

            assertTrue(lifecycle.noteExactResult(
                modelId = "qwen3-0.6b-int8",
                modelVersion = "1",
                runtimeVersion = "sherpa-onnx-1.13.6",
                manifestSha256 = null,
                activationGeneration = null,
                resultId = lifecycle.resultIdForPayloadSha256(payloadSha)!!,
                resultPayloadSha256 = payloadSha,
            ))
        } finally {
            root.deleteRecursively()
        }
    }

    private fun writer(manifestSha: String) = JSONObject()
        .put("manifestSha256", manifestSha)
        .put("platform", "android")

    private fun record(manifest: JSONObject, state: String, reason: String, generation: Long = 0L) = JSONObject()
        .put("schemaVersion", "maina.model-pack-lifecycle-record.v1")
        .put("packId", "qwen3-asr-0.6b-int8")
        .put("packVersion", manifest.getString("packVersion"))
        .put("manifestSha256", manifest.getString("manifestSha256"))
        .put("platform", "android")
        .put("activationGeneration", generation)
        .put("state", state)
        .put("bytesComplete", if (state == "downloading") 0 else requiredFiles.sumOf { it.second })
        .put("bytesTotal", requiredFiles.sumOf { it.second })
        .put("reasonCode", reason)
        .put("verifiedChunks", JSONObject())

    private fun pointer(manifest: JSONObject, generation: Long) = JSONObject()
        .put("packId", "qwen3-asr-0.6b-int8")
        .put("packVersion", manifest.getString("packVersion"))
        .put("manifestSha256", manifest.getString("manifestSha256"))
        .put("platform", "android")
        .put("activationGeneration", generation)
        .put("runtimeVersion", "sherpa-onnx-1.13.6")

    private fun syntheticManifest(packVersion: String = "synthetic-1", hashCharacter: Char = '1'): JSONObject {
        val files = JSONArray()
        requiredFiles.forEachIndexed { index, (path, bytes) ->
            files.put(JSONObject()
                .put("path", path)
                .put("byteCount", bytes)
                .put("sha256", if (hashCharacter == '1') "${index + 1}".repeat(64) else hashCharacter.toString().repeat(64))
                .put("chunkSizeBytes", bytes)
                .put("chunkSha256", JSONArray().put(if (hashCharacter == '1') "${index + 1}".repeat(64) else hashCharacter.toString().repeat(64))))
        }
        val manifest = JSONObject()
            .put("schemaVersion", "maina.model-pack-manifest.v1")
            .put("packId", "qwen3-asr-0.6b-int8")
            .put("packVersion", packVersion)
            .put("engineId", "qwen3-0.6b-int8")
            .put("formatVersion", "1")
            .put("files", files)
            .put("platforms", JSONArray()
                .put(platform("android", "26", "arm64-v8a", "sherpa-onnx-1.13.6", "0012d9a28f15bd6fb966b62b70a75da3990512fdccce28b83098248ce4be1698", "a".repeat(64)))
                .put(platform("ios", "17.0", "arm64", "sherpa-onnx-1.13.4-ios-no-tts", "d8baaa925248e8e8ad23870208cdaf3d093623e6733aede2c23862f30c5aac62", "b".repeat(64))))
            .put("smokeInputSha256", hashCharacter.toString().repeat(64))
        manifest.put("manifestSha256", sha256(canonicalJson(manifest)))
        return manifest
    }

    private fun rehashManifest(manifest: JSONObject) {
        manifest.remove("manifestSha256")
        manifest.put("manifestSha256", sha256(canonicalJson(manifest)))
    }

    private fun platform(os: String, min: String, architecture: String, runtime: String, runtimeSha: String, smokeSha: String) =
        JSONObject()
            .put("osFamily", os)
            .put("minOsVersion", min)
            .put("architectures", JSONArray().put(architecture))
            .put("runtimeVersion", runtime)
            .put("runtimeSha256", runtimeSha)
            .put("smokeExpectedTextSha256", smokeSha)

    private fun canonicalJson(value: Any?): String = when (value) {
        null, JSONObject.NULL -> "null"
        is String -> JSONObject.quote(value)
        is Boolean -> if (value) "true" else "false"
        is Number -> value.toLong().toString()
        is JSONArray -> (0 until value.length()).joinToString(prefix = "[", postfix = "]") { canonicalJson(value.get(it)) }
        is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(prefix = "{", postfix = "}") {
            "${JSONObject.quote(it)}:${canonicalJson(value.get(it))}"
        }
        else -> error("unsupported fixture value")
    }

    private fun sha256(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray())
        .joinToString("") { "%02x".format(it) }

    private companion object {
        val requiredFiles = listOf(
            "conv_frontend.onnx" to 44_148_281L,
            "encoder.int8.onnx" to 182_491_662L,
            "decoder.int8.onnx" to 755_914_231L,
            "tokenizer/vocab.json" to 2_776_833L,
            "tokenizer/merges.txt" to 1_671_853L,
            "tokenizer/tokenizer_config.json" to 12_487L,
        )
    }
}
