package com.divay.maina.recorder

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MainaQualificationSessionPolicyTest {
    @Test
    fun diagnosticsOwnershipHasOneCrashReconciledForwardProtocol() {
        val ordinary = MainaDiagnosticsQualificationPhase.ORDINARY
        val reserved = MainaDiagnosticsQualificationPhase.RESERVED
        val active = MainaDiagnosticsQualificationPhase.CAPTURE_ACTIVE
        val terminal = MainaDiagnosticsQualificationPhase.TERMINAL_READY
        assertTrue(MainaDiagnosticsQualificationTransitionPolicy.allowed(ordinary, reserved))
        assertTrue(MainaDiagnosticsQualificationTransitionPolicy.allowed(reserved, active))
        assertTrue(MainaDiagnosticsQualificationTransitionPolicy.allowed(active, terminal))
        assertTrue(MainaDiagnosticsQualificationTransitionPolicy.allowed(terminal, ordinary))
        assertTrue(MainaDiagnosticsQualificationTransitionPolicy.allowed(reserved, ordinary))
        assertFalse(MainaDiagnosticsQualificationTransitionPolicy.allowed(active, ordinary))
        assertFalse(MainaDiagnosticsQualificationTransitionPolicy.allowed(ordinary, active))
        assertFalse(MainaDiagnosticsQualificationTransitionPolicy.allowed(terminal, active))
        assertTrue(MainaDiagnosticsQualificationTransitionPolicy.mayReconcileWithoutCaptureControl(reserved))
        assertTrue(MainaDiagnosticsQualificationTransitionPolicy.mayReconcileWithoutCaptureControl(terminal))
        assertFalse(MainaDiagnosticsQualificationTransitionPolicy.mayReconcileWithoutCaptureControl(active))
    }

    @Test
    fun restartRecoveryIsExplicitAtEveryCrossStoreCrashBoundary() {
        val action = MainaDiagnosticsQualificationRecoveryPolicy::action
        assertEquals(MainaQualificationRecoveryAction.NONE, action(
            MainaDiagnosticsQualificationPhase.ORDINARY,
            MainaQualificationControlRelation.ABSENT,
        ))
        assertEquals(MainaQualificationRecoveryAction.CANCEL_RESERVATION, action(
            MainaDiagnosticsQualificationPhase.RESERVED,
            MainaQualificationControlRelation.ABSENT,
        ))
        assertEquals(MainaQualificationRecoveryAction.ACTIVATE_CAPTURE, action(
            MainaDiagnosticsQualificationPhase.RESERVED,
            MainaQualificationControlRelation.MATCHING_ACTIVE,
        ))
        assertEquals(MainaQualificationRecoveryAction.RESTORE_CAPTURE, action(
            MainaDiagnosticsQualificationPhase.CAPTURE_ACTIVE,
            MainaQualificationControlRelation.MATCHING_ACTIVE,
        ))
        assertEquals(MainaQualificationRecoveryAction.PRESERVE_TERMINAL, action(
            MainaDiagnosticsQualificationPhase.CAPTURE_ACTIVE,
            MainaQualificationControlRelation.MATCHING_TERMINAL,
        ))
        assertEquals(MainaQualificationRecoveryAction.CLEAR_TERMINAL, action(
            MainaDiagnosticsQualificationPhase.TERMINAL_READY,
            MainaQualificationControlRelation.MATCHING_TERMINAL,
        ))
        assertEquals(MainaQualificationRecoveryAction.COMPLETE_TERMINAL, action(
            MainaDiagnosticsQualificationPhase.TERMINAL_READY,
            MainaQualificationControlRelation.ABSENT,
        ))
        for (phase in MainaDiagnosticsQualificationPhase.entries.filter {
            it != MainaDiagnosticsQualificationPhase.ORDINARY
        }) {
            assertEquals(MainaQualificationRecoveryAction.BLOCK, action(
                phase,
                MainaQualificationControlRelation.INVALID,
            ))
            assertEquals(MainaQualificationRecoveryAction.BLOCK, action(
                phase,
                MainaQualificationControlRelation.OTHER,
            ))
        }
        assertEquals(MainaQualificationRecoveryAction.BLOCK, action(
            MainaDiagnosticsQualificationPhase.CAPTURE_ACTIVE,
            MainaQualificationControlRelation.ABSENT,
        ))
    }

    @Test
    fun terminalRestartPreservesSaveButNeverPostProcessesDiscard() {
        assertEquals(
            MainaTerminalRestartAction.PRESERVE_FOR_POST_PROCESSING,
            MainaCaptureTerminalRecoveryPolicy.restartAction(MainaCaptureTerminalDisposition.SAVE),
        )
        assertEquals(
            MainaTerminalRestartAction.DELETE_CAPTURE,
            MainaCaptureTerminalRecoveryPolicy.restartAction(MainaCaptureTerminalDisposition.DISCARD),
        )
    }

    @Test
    fun runIdIsExactAndCanonical() {
        assertEquals(
            "00000000-0000-4000-8000-000000000001",
            MainaQualificationSessionPolicy.canonicalRunId("00000000-0000-4000-8000-000000000001"),
        )
        assertNull(MainaQualificationSessionPolicy.canonicalRunId("unarmed"))
        assertNull(MainaQualificationSessionPolicy.canonicalRunId("00000000-0000-0000-0000-000000000001"))
        assertNull(MainaQualificationSessionPolicy.canonicalRunId("00000000-0000-4000-8000-000000000001-extra"))
    }

    @Test
    fun qualificationSessionSuppressesDiagnostics() {
        assertFalse(MainaQualificationSessionPolicy.diagnosticsAllowed(true))
        assertTrue(MainaQualificationSessionPolicy.diagnosticsAllowed(false))
    }

    @Test
    fun qualificationExtraRequiresTheNativeBooleanType() {
        assertTrue(MainaQualificationSessionPolicy.decodeQualificationExtra(true))
        assertFalse(MainaQualificationSessionPolicy.decodeQualificationExtra(false))
        assertFalse(MainaQualificationSessionPolicy.decodeQualificationExtra("true"))
        assertFalse(MainaQualificationSessionPolicy.decodeQualificationExtra(1))
        assertFalse(MainaQualificationSessionPolicy.decodeQualificationExtra(null))
    }

    @Test
    fun evidenceDigestIsExactCanonicalAndNonReusable() {
        val lower = "00000000-0000-4000-8000-000000000001"
        val upper = lower.uppercase()
        val digest = MainaQualificationSessionPolicy.evidenceDigest(lower)
        assertEquals(64, digest?.length)
        assertEquals(digest, MainaQualificationSessionPolicy.evidenceDigest(upper))
        assertEquals(digest, MainaQualificationSessionPolicy.canonicalEvidenceDigest(digest))
        assertNull(MainaQualificationSessionPolicy.evidenceDigest("invalid"))
        assertNull(MainaQualificationSessionPolicy.canonicalEvidenceDigest(digest?.uppercase()))
        assertNull(MainaQualificationSessionPolicy.canonicalEvidenceDigest("0".repeat(63)))
    }

    @Test
    fun capabilityIsSingleUseFreshnessBoundedAndNonEvicting() {
        var persisted = emptySet<String>()
        val state = MainaQualificationSessionStateMachine(persisted, { next ->
            persisted = next
            true
        })
        val first = "00000000-0000-4000-8000-000000000001"
        val second = "00000000-0000-4000-8000-000000000002"
        assertTrue(state.arm(first, 1_000L))
        assertFalse(state.arm(second, 1_001L))
        assertTrue(state.consume(first, 1_100L))
        assertFalse(state.consume(first, 1_101L))
        assertFalse(state.arm(first, 1_102L))
        assertTrue(state.arm(second, 1_103L))
        assertTrue(state.consume(second, 1_104L))
        assertEquals(setOfNotNull(
            MainaQualificationSessionPolicy.evidenceDigest(first),
            MainaQualificationSessionPolicy.evidenceDigest(second),
        ), persisted)

        val restarted = MainaQualificationSessionStateMachine(persisted, { true })
        assertFalse(restarted.arm(first, 2_000L))
    }

    @Test
    fun expiredOrRebootedPendingCapabilityFailsClosed() {
        val persisted = mutableSetOf<String>()
        val expired = MainaQualificationSessionStateMachine(emptySet(), { next ->
            persisted.clear()
            persisted.addAll(next)
            true
        })
        val first = "00000000-0000-4000-8000-000000000011"
        val second = "00000000-0000-4000-8000-000000000012"
        assertTrue(expired.arm(first, 10_000L))
        assertFalse(expired.consume(first, 25_001L))
        assertTrue(expired.arm(second, 25_002L))
        assertFalse(expired.consume(second, 1L))
        assertEquals(setOfNotNull(
            MainaQualificationSessionPolicy.evidenceDigest(first),
            MainaQualificationSessionPolicy.evidenceDigest(second),
        ), persisted)
    }

    @Test
    fun exactTtlBoundaryIsAcceptedAndHistoryDoesNotEvict() {
        var persisted = emptySet<String>()
        var state = MainaQualificationSessionStateMachine(persisted, { next ->
            persisted = next
            true
        })
        val first = "00000000-0000-4000-8000-000000000031"
        assertTrue(state.arm(first, 10_000L))
        assertTrue(state.consume(first, 25_000L))
        repeat(40) { index ->
            val runId = "00000000-0000-4000-8000-${(1000 + index).toString(16).padStart(12, '0')}"
            assertTrue(state.arm(runId, 30_000L + index * 2L))
            assertTrue(state.consume(runId, 30_001L + index * 2L))
        }
        state = MainaQualificationSessionStateMachine(persisted, { true })
        assertFalse(state.arm(first, 40_000L))
    }

    @Test
    fun storageAmbiguityNeverCreatesAPendingCapability() {
        val runId = "00000000-0000-4000-8000-000000000021"
        val otherRunId = "00000000-0000-4000-8000-000000000022"
        val state = MainaQualificationSessionStateMachine(emptySet(), { false })
        assertFalse(state.arm(runId, 1_000L))
        assertFalse(state.consume(runId, 1_001L))
        assertFalse(state.arm(otherRunId, 1_002L))
    }
}
