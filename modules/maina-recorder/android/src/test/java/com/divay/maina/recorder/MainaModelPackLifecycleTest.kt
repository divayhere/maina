package com.divay.maina.recorder

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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
    fun `candidate acquisition telemetry does not mask the retained ready pack`() {
        listOf("downloading", "failed_download", "failed_verification", "failed_smoke").forEach { state ->
            val root = Files.createTempDirectory("maina-model-pack-serving-$state").toFile().canonicalFile
            try {
                val ready = syntheticManifest(packVersion = "ready-a", hashCharacter = 'a')
                val candidate = syntheticManifest(packVersion = "candidate-b", hashCharacter = 'b')
                installPack(root, ready, generation = 1L)
                root.resolve("ready.json").writeText(pointer(ready, 1L).toString())
                root.resolve("staging/${candidate.getString("manifestSha256")}").apply {
                    mkdirs()
                    resolve("manifest.json").writeText(candidate.toString())
                }
                root.resolve("records/${candidate.getString("manifestSha256")}.json").apply {
                    parentFile!!.mkdirs()
                    writeText(record(candidate, state, if (state.startsWith("failed_")) "SYNTHETIC_FAILURE" else "NONE").toString())
                }
                root.resolve("current.json").writeText(writer(candidate.getString("manifestSha256")).toString())

                val lifecycle = MainaModelPackLifecycle(root = root, directorySync = {})
                assertEquals(state, lifecycle.status().state)
                val selected = lifecycle.acquireReady()
                assertEquals(ready.getString("manifestSha256"), selected?.manifestSha256)
                selected?.release()
            } finally {
                root.deleteRecursively()
            }
        }
    }

    @Test
    fun `present invalid ready pointer never falls through as absent`() {
        val root = Files.createTempDirectory("maina-model-pack-invalid-ready").toFile().canonicalFile
        try {
            val missing = syntheticManifest(packVersion = "missing-ready", hashCharacter = 'a')
            root.resolve("ready.json").writeText(pointer(missing, 1L).toString())
            val lifecycle = MainaModelPackLifecycle(root = root, directorySync = {})

            assertEquals("rollback_pending", lifecycle.status().state)
            assertTrue(runCatching { lifecycle.acquireReady() }.isFailure)
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `open failure rollback replays every durable cutpoint and retains previous ready`() {
        for (cutpoint in 1..7) {
            val root = Files.createTempDirectory("maina-model-pack-rollback-$cutpoint").toFile().canonicalFile
            try {
                val previous = syntheticManifest(packVersion = "ready-a", hashCharacter = 'a')
                val failed = syntheticManifest(packVersion = "candidate-b", hashCharacter = 'b')
                installPack(root, previous, generation = 1L)
                installPack(root, failed, generation = 2L)
                root.resolve("ready.json").writeText(pointer(failed, 2L).toString())
                root.resolve("previous-ready.json").writeText(pointer(previous, 1L).toString())
                root.resolve("current.json").writeText(writer(failed.getString("manifestSha256")).toString())

                var durableWrites = 0
                val lifecycle = MainaModelPackLifecycle(root = root, directorySync = {
                    durableWrites += 1
                    if (durableWrites == cutpoint) throw IllegalStateException("SYNTHETIC_PROCESS_DEATH")
                })
                val failedHandle = lifecycle.acquireReady()!!
                runCatching { lifecycle.rollbackAfterOpenFailure(failedHandle) }
                failedHandle.release()

                val restarted = MainaModelPackLifecycle(root = root, directorySync = {})
                val status = restarted.status()
                assertEquals("failed_smoke", status.state)
                assertEquals("MODEL_OPEN_FAILED_ROLLED_BACK", status.reasonCode)
                val restored = restarted.acquireReady()
                assertEquals(previous.getString("manifestSha256"), restored?.manifestSha256)
                restored?.release()
                assertFalse(root.resolve("open-rollback.json").exists())
                assertFalse(root.resolve("previous-ready.json").exists())
            } finally {
                root.deleteRecursively()
            }
        }
    }

    @Test
    fun `open failure cannot roll back a generation after its first exact result`() {
        val root = Files.createTempDirectory("maina-model-pack-post-result-rollback").toFile().canonicalFile
        try {
            val previous = syntheticManifest(packVersion = "ready-a", hashCharacter = 'a')
            val active = syntheticManifest(packVersion = "candidate-b", hashCharacter = 'b')
            installPack(root, previous, generation = 1L)
            installPack(root, active, generation = 2L)
            root.resolve("ready.json").writeText(pointer(active, 2L).toString())
            root.resolve("previous-ready.json").writeText(pointer(previous, 1L).toString())
            root.resolve("current.json").writeText(writer(active.getString("manifestSha256")).toString())
            val lifecycle = MainaModelPackLifecycle(root = root, directorySync = {})
            val handle = lifecycle.acquireReady()!!
            val payloadSha = lifecycle.resultPayloadSha256(mapOf("runId" to "bound-result", "state" to "complete"))
            val resultId = lifecycle.resultIdForPayloadSha256(payloadSha)!!
            assertTrue(lifecycle.noteExactResult(
                modelId = "qwen3-0.6b-int8",
                modelVersion = active.getString("packVersion"),
                runtimeVersion = "sherpa-onnx-1.13.6",
                manifestSha256 = active.getString("manifestSha256"),
                activationGeneration = 2L,
                resultId = resultId,
                resultPayloadSha256 = payloadSha,
            ))

            assertFalse(lifecycle.rollbackAfterOpenFailure(handle))
            val stillActive = lifecycle.acquireReady()
            assertEquals(active.getString("manifestSha256"), stillActive?.manifestSha256)
            stillActive?.release()
            assertEquals("ready", lifecycle.status().state)
            assertTrue(root.resolve("results/${active.getString("manifestSha256")}-2.json").isFile)
            assertFalse(root.resolve("open-rollback.json").exists())
            handle.release()
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `one failing reader cannot roll back a generation held by another reader`() {
        val root = Files.createTempDirectory("maina-model-pack-concurrent-reader").toFile().canonicalFile
        try {
            val previous = syntheticManifest(packVersion = "ready-a", hashCharacter = 'a')
            val active = syntheticManifest(packVersion = "candidate-b", hashCharacter = 'b')
            installPack(root, previous, generation = 1L)
            installPack(root, active, generation = 2L)
            root.resolve("ready.json").writeText(pointer(active, 2L).toString())
            root.resolve("previous-ready.json").writeText(pointer(previous, 1L).toString())
            root.resolve("current.json").writeText(writer(active.getString("manifestSha256")).toString())
            val lifecycle = MainaModelPackLifecycle(root = root, directorySync = {})
            val failingReader = lifecycle.acquireReady()!!
            val activeReader = lifecycle.acquireReady()!!

            assertTrue(lifecycle.rollbackAfterOpenFailure(failingReader))
            assertTrue(root.resolve("open-rollback.json").isFile)
            assertTrue(runCatching { lifecycle.acquireReady() }.isFailure)
            failingReader.release()
            val payloadSha = lifecycle.resultPayloadSha256(mapOf("runId" to "concurrent-reader", "state" to "complete"))
            assertTrue(lifecycle.noteExactResult(
                modelId = "qwen3-0.6b-int8",
                modelVersion = active.getString("packVersion"),
                runtimeVersion = "sherpa-onnx-1.13.6",
                manifestSha256 = active.getString("manifestSha256"),
                activationGeneration = 2L,
                resultId = lifecycle.resultIdForPayloadSha256(payloadSha)!!,
                resultPayloadSha256 = payloadSha,
            ))
            assertEquals("ready", lifecycle.status().state)
            activeReader.release()
            assertFalse(root.resolve("open-rollback.json").exists())
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `prepared fence retains bytes without claiming a phantom first exact result`() {
        val root = Files.createTempDirectory("maina-model-pack-prepared-result").toFile().canonicalFile
        try {
            val previous = syntheticManifest(packVersion = "ready-a", hashCharacter = 'a')
            val active = syntheticManifest(packVersion = "candidate-b", hashCharacter = 'b')
            installPack(root, previous, generation = 1L)
            installPack(root, active, generation = 2L)
            root.resolve("ready.json").writeText(pointer(active, 2L).toString())
            root.resolve("previous-ready.json").writeText(pointer(previous, 1L).toString())
            root.resolve("current.json").writeText(writer(active.getString("manifestSha256")).toString())
            val lifecycle = MainaModelPackLifecycle(root = root, directorySync = {})
            val handle = lifecycle.acquireReady()!!
            val uncommittedSha = lifecycle.resultPayloadSha256(mapOf("runId" to "run-1", "updatedAt" to 1L))
            val uncommittedId = lifecycle.resultIdForPayloadSha256(uncommittedSha)!!

            assertTrue(lifecycle.prepareExactResult(
                modelId = "qwen3-0.6b-int8",
                modelVersion = active.getString("packVersion"),
                runtimeVersion = "sherpa-onnx-1.13.6",
                manifestSha256 = active.getString("manifestSha256"),
                activationGeneration = 2L,
                resultId = uncommittedId,
                resultPayloadSha256 = uncommittedSha,
            ))
            assertFalse(root.resolve("results/${active.getString("manifestSha256")}-2.json").exists())
            assertTrue(lifecycle.rollbackAfterOpenFailure(handle))
            handle.release()
            val restored = lifecycle.acquireReady()
            assertEquals(previous.getString("manifestSha256"), restored?.manifestSha256)
            restored?.release()
            assertTrue(root.resolve("packs/${active.getString("manifestSha256")}").isDirectory)

            // A rolled-back transaction cannot turn a different later payload
            // into the first exact result without its own matching preparation.
            val committedSha = lifecycle.resultPayloadSha256(mapOf("runId" to "run-1", "updatedAt" to 2L))
            val committedId = lifecycle.resultIdForPayloadSha256(committedSha)!!
            assertFalse(lifecycle.noteExactResult(
                modelId = "qwen3-0.6b-int8",
                modelVersion = active.getString("packVersion"),
                runtimeVersion = "sherpa-onnx-1.13.6",
                manifestSha256 = active.getString("manifestSha256"),
                activationGeneration = 2L,
                resultId = committedId,
                resultPayloadSha256 = committedSha,
            ))
            // If the original Outbox transaction did commit but the process
            // died before finalization, its exact prepared payload remains
            // finalizable even though serving has safely rolled back to A.
            assertTrue(lifecycle.noteExactResult(
                modelId = "qwen3-0.6b-int8",
                modelVersion = active.getString("packVersion"),
                runtimeVersion = "sherpa-onnx-1.13.6",
                manifestSha256 = active.getString("manifestSha256"),
                activationGeneration = 2L,
                resultId = uncommittedId,
                resultPayloadSha256 = uncommittedSha,
            ))
            val mapping = JSONObject(root.resolve("results/${active.getString("manifestSha256")}-2.json").readText())
            assertEquals(uncommittedId, mapping.getString("firstExactResultId"))
            assertEquals(uncommittedSha, mapping.getString("firstExactResultSha256"))
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `transient status reader defers but cannot lose an open failure rollback`() {
        val root = Files.createTempDirectory("maina-model-pack-deferred-reader-rollback").toFile().canonicalFile
        try {
            val previous = syntheticManifest(packVersion = "ready-a", hashCharacter = 'a')
            val failed = syntheticManifest(packVersion = "candidate-b", hashCharacter = 'b')
            installPack(root, previous, generation = 1L)
            installPack(root, failed, generation = 2L)
            root.resolve("ready.json").writeText(pointer(failed, 2L).toString())
            root.resolve("previous-ready.json").writeText(pointer(previous, 1L).toString())
            root.resolve("current.json").writeText(writer(failed.getString("manifestSha256")).toString())
            val lifecycle = MainaModelPackLifecycle(root = root, directorySync = {})
            val failingReader = lifecycle.acquireReady()!!
            val statusReader = lifecycle.acquireReady()!!

            assertTrue(lifecycle.rollbackAfterOpenFailure(failingReader))
            assertTrue(root.resolve("open-rollback.json").isFile)
            failingReader.release()
            assertEquals(failed.getString("manifestSha256"), JSONObject(root.resolve("ready.json").readText()).getString("manifestSha256"))

            // Releasing the unrelated transient reader replays the already
            // durable rollback request without requiring a second failure.
            statusReader.release()
            assertFalse(root.resolve("open-rollback.json").exists())
            val restored = lifecycle.acquireReady()
            assertEquals(previous.getString("manifestSha256"), restored?.manifestSha256)
            restored?.release()
            assertEquals("failed_smoke", lifecycle.status().state)
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `stale reader pin is removed and does not permanently suppress rollback`() {
        val root = Files.createTempDirectory("maina-model-pack-stale-reader").toFile().canonicalFile
        try {
            val previous = syntheticManifest(packVersion = "ready-a", hashCharacter = 'a')
            val failed = syntheticManifest(packVersion = "candidate-b", hashCharacter = 'b')
            installPack(root, previous, generation = 1L)
            installPack(root, failed, generation = 2L)
            root.resolve("ready.json").writeText(pointer(failed, 2L).toString())
            root.resolve("previous-ready.json").writeText(pointer(previous, 1L).toString())
            root.resolve("current.json").writeText(writer(failed.getString("manifestSha256")).toString())
            val stalePin = root.resolve("readers/${failed.getString("manifestSha256")}/stale-reader").apply {
                parentFile!!.mkdirs()
                writeText("generation=2\n")
            }
            val lifecycle = MainaModelPackLifecycle(root = root, directorySync = {})
            val failedHandle = lifecycle.acquireReady()!!

            assertTrue(lifecycle.rollbackAfterOpenFailure(failedHandle))
            failedHandle.release()
            assertFalse(stalePin.exists())
            val restored = lifecycle.acquireReady()
            assertEquals(previous.getString("manifestSha256"), restored?.manifestSha256)
            restored?.release()
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `ready rollback preserves an unrelated exact acquisition writer and telemetry`() {
        val root = Files.createTempDirectory("maina-model-pack-rollback-with-writer").toFile().canonicalFile
        try {
            val previous = syntheticManifest(packVersion = "ready-a", hashCharacter = 'a')
            val failed = syntheticManifest(packVersion = "candidate-b", hashCharacter = 'b')
            val downloading = syntheticManifest(packVersion = "candidate-c", hashCharacter = 'c')
            installPack(root, previous, generation = 1L)
            installPack(root, failed, generation = 2L)
            root.resolve("ready.json").writeText(pointer(failed, 2L).toString())
            root.resolve("previous-ready.json").writeText(pointer(previous, 1L).toString())
            root.resolve("staging/${downloading.getString("manifestSha256")}").apply {
                mkdirs()
                resolve("manifest.json").writeText(downloading.toString())
            }
            root.resolve("records/${downloading.getString("manifestSha256")}.json").writeText(
                record(downloading, "downloading", "NONE").toString(),
            )
            val writer = writer(downloading.getString("manifestSha256"))
            root.resolve("writer.json").writeText(writer.toString())
            root.resolve("current.json").writeText(writer.toString())
            val lifecycle = MainaModelPackLifecycle(root = root, directorySync = {})
            val failedHandle = lifecycle.acquireReady()!!

            assertTrue(lifecycle.rollbackAfterOpenFailure(failedHandle))
            failedHandle.release()
            val restored = lifecycle.acquireReady()
            assertEquals(previous.getString("manifestSha256"), restored?.manifestSha256)
            restored?.release()
            assertEquals("downloading", lifecycle.status().state)
            assertEquals(
                downloading.getString("manifestSha256"),
                JSONObject(root.resolve("writer.json").readText()).getString("manifestSha256"),
            )
            assertEquals(
                downloading.getString("manifestSha256"),
                JSONObject(root.resolve("current.json").readText()).getString("manifestSha256"),
            )
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `durable result cancels a replayed open failure intent before pointer mutation`() {
        val root = Files.createTempDirectory("maina-model-pack-result-wins-rollback").toFile().canonicalFile
        try {
            val previous = syntheticManifest(packVersion = "ready-a", hashCharacter = 'a')
            val active = syntheticManifest(packVersion = "candidate-b", hashCharacter = 'b')
            installPack(root, previous, generation = 1L)
            installPack(root, active, generation = 2L)
            root.resolve("ready.json").writeText(pointer(active, 2L).toString())
            root.resolve("previous-ready.json").writeText(pointer(previous, 1L).toString())
            root.resolve("current.json").writeText(writer(active.getString("manifestSha256")).toString())
            val lifecycle = MainaModelPackLifecycle(root = root, directorySync = {})
            val payloadSha = lifecycle.resultPayloadSha256(mapOf("runId" to "durable-result", "state" to "complete"))
            val resultId = lifecycle.resultIdForPayloadSha256(payloadSha)!!
            assertTrue(lifecycle.noteExactResult(
                modelId = "qwen3-0.6b-int8",
                modelVersion = active.getString("packVersion"),
                runtimeVersion = "sherpa-onnx-1.13.6",
                manifestSha256 = active.getString("manifestSha256"),
                activationGeneration = 2L,
                resultId = resultId,
                resultPayloadSha256 = payloadSha,
            ))
            root.resolve("open-rollback.json").writeText(JSONObject()
                .put("schemaVersion", "maina.model-pack-open-rollback.v1")
                .put("failedManifestSha256", active.getString("manifestSha256"))
                .put("failedActivationGeneration", 2L)
                .put("ignoredReaderPinName", "synthetic-failed-reader")
                .put("previousReady", pointer(previous, 1L))
                .toString())

            assertEquals("ready", lifecycle.status().state)
            val stillActive = lifecycle.acquireReady()
            assertEquals(active.getString("manifestSha256"), stillActive?.manifestSha256)
            stillActive?.release()
            assertFalse(root.resolve("open-rollback.json").exists())
            assertTrue(root.resolve("previous-ready.json").isFile)
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `durable rollback intent is reconciled before accepting a later exact result`() {
        val root = Files.createTempDirectory("maina-model-pack-rollback-wins-result").toFile().canonicalFile
        try {
            val previous = syntheticManifest(packVersion = "ready-a", hashCharacter = 'a')
            val failed = syntheticManifest(packVersion = "candidate-b", hashCharacter = 'b')
            installPack(root, previous, generation = 1L)
            installPack(root, failed, generation = 2L)
            root.resolve("ready.json").writeText(pointer(failed, 2L).toString())
            root.resolve("previous-ready.json").writeText(pointer(previous, 1L).toString())
            root.resolve("current.json").writeText(writer(failed.getString("manifestSha256")).toString())
            var writes = 0
            val lifecycle = MainaModelPackLifecycle(root = root, directorySync = {
                writes += 1
                if (writes == 1) throw IllegalStateException("SYNTHETIC_PROCESS_DEATH")
            })
            val failedHandle = lifecycle.acquireReady()!!
            assertTrue(runCatching { lifecycle.rollbackAfterOpenFailure(failedHandle) }.isFailure)
            assertTrue(root.resolve("open-rollback.json").isFile)
            failedHandle.release()
            val payloadSha = lifecycle.resultPayloadSha256(mapOf("runId" to "late-result", "state" to "complete"))

            assertFalse(lifecycle.noteExactResult(
                modelId = "qwen3-0.6b-int8",
                modelVersion = failed.getString("packVersion"),
                runtimeVersion = "sherpa-onnx-1.13.6",
                manifestSha256 = failed.getString("manifestSha256"),
                activationGeneration = 2L,
                resultId = lifecycle.resultIdForPayloadSha256(payloadSha)!!,
                resultPayloadSha256 = payloadSha,
            ))
            val restored = lifecycle.acquireReady()
            assertEquals(previous.getString("manifestSha256"), restored?.manifestSha256)
            restored?.release()
            assertFalse(root.resolve("results/${failed.getString("manifestSha256")}-2.json").exists())
            assertFalse(root.resolve("open-rollback.json").exists())
        } finally {
            root.deleteRecursively()
        }
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

    @Test
    fun `legacy result remains bindable after a managed pack becomes ready`() {
        val root = Files.createTempDirectory("maina-model-pack-legacy-result-after-promotion").toFile().canonicalFile
        try {
            val managed = syntheticManifest(packVersion = "managed-ready", hashCharacter = 'a')
            installPack(root, managed, generation = 1L)
            root.resolve("ready.json").writeText(pointer(managed, 1L).toString())
            root.resolve("current.json").writeText(writer(managed.getString("manifestSha256")).toString())
            val lifecycle = MainaModelPackLifecycle(root = root, directorySync = {})
            val payloadSha = lifecycle.resultPayloadSha256(mapOf("runId" to "legacy-before-promotion", "state" to "complete"))

            assertTrue(lifecycle.noteExactResult(
                modelId = "qwen3-0.6b-int8",
                modelVersion = "1",
                runtimeVersion = "sherpa-onnx-1.13.6",
                manifestSha256 = null,
                activationGeneration = null,
                resultId = lifecycle.resultIdForPayloadSha256(payloadSha)!!,
                resultPayloadSha256 = payloadSha,
            ))
            val stillManaged = lifecycle.acquireReady()
            assertEquals(managed.getString("manifestSha256"), stillManaged?.manifestSha256)
            stillManaged?.release()
        } finally {
            root.deleteRecursively()
        }
    }

    private fun writer(manifestSha: String) = JSONObject()
        .put("manifestSha256", manifestSha)
        .put("platform", "android")

    private fun installPack(root: java.io.File, manifest: JSONObject, generation: Long) {
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
