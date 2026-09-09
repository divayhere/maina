package com.divay.maina.recorder

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

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
}
