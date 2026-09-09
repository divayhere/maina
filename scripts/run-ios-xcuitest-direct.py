#!/usr/bin/env python3
"""Run the finite Maina iPhone UI-test set through the pinned DVT transport."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import sys
import time
from pathlib import Path

from pymobiledevice3.remote.native_tunnel import establish_native_rsd
from pymobiledevice3.services.dvt.testmanaged.dtx_services import (
    XCUITestListener,
    XCTestCaseResult,
)
from pymobiledevice3.services.dvt.testmanaged.xcuitest import TestConfig, XCUITestService
from pymobiledevice3.services.dvt.testmanaged.xctest_types import XCActivityRecord, XCTAttachment


DEVICE_UDID = "00008120-001E146611E2601E"
RUNNER_BUNDLE_ID = "com.divay.maina.staging.qualify1048.uitests.xctrunner"
TARGET_BUNDLE_ID = "com.divay.maina.staging"
EXPECTED_VERSION = "0.10.60"
EXPECTED_BUILD = "42"
ALLOWED_TESTS = {
    "navigation-audit": "MainaUITests/testNavigationAudit",
    "short-recording-lifecycle": "MainaUITests/testShortRecordingLifecycle",
    "rapid-pause-resume": "MainaUITests/testRapidPauseResumeFirstTap",
    "paused-state": "MainaUITests/testPausedStatePersistsUntilResume",
    "background-recording": "MainaUITests/testBackgroundForegroundRecording",
    "discard-recording": "MainaUITests/testDiscardRecordingLifecycle",
    "process-death-recovery": "MainaUITests/testProcessDeathRecovery",
    "long-recording": "MainaUITests/testLongRecordingWithBackgroundAndPauses",
}


class SanitizedListener(XCUITestListener):
    def __init__(self, result_directory: Path) -> None:
        self.plan_started = False
        self.plan_finished = False
        self.cases: dict[str, dict[str, object]] = {}
        self.failure_count = 0
        self.failure_locations: list[dict[str, object]] = []
        self.initialization_failed = False
        self.result_directory = result_directory
        self.screenshots: list[dict[str, object]] = []

    async def did_begin_executing_test_plan(self) -> None:
        self.plan_started = True

    async def did_finish_executing_test_plan(self) -> None:
        self.plan_finished = True

    async def test_case_did_finish(self, result: XCTestCaseResult) -> None:
        method = result.method.removesuffix("()")
        self.cases[method] = {
            "status": result.status,
            "durationMs": round(result.duration * 1000),
        }

    async def test_case_did_fail(
        self, test_class: str, method: str, message: str, file: str, line: int
    ) -> None:
        self.failure_count += 1
        method_name = method.removesuffix("()")
        source_name = Path(file).name
        if (
            method_name in {value.split("/", 1)[1] for value in ALLOWED_TESTS.values()}
            and source_name == "MainaUITests.swift"
            and isinstance(line, int)
            and 1 <= line <= 10_000
        ):
            # Preserve only the bounded source location. Raw XCTest messages
            # can contain device or application content and are never stored.
            self.failure_locations.append({
                "method": method_name,
                "source": source_name,
                "line": line,
            })

    async def initialization_for_ui_testing_did_fail(self, error: object) -> None:
        self.initialization_failed = True

    async def did_fail_to_bootstrap(self, error: object) -> None:
        self.initialization_failed = True

    async def test_case_did_finish_activity(
        self, test_class: str, method: str, activity: XCActivityRecord
    ) -> None:
        for attachment in activity.attachments:
            if not isinstance(attachment, XCTAttachment) or attachment.data is None:
                continue
            if attachment.uniformTypeIdentifier not in {"public.png", "public.jpeg", "public.image"}:
                continue
            safe_name = "".join(
                character.lower() if character.isalnum() else "-"
                for character in attachment.name
            ).strip("-")[:64] or "screenshot"
            suffix = ".jpg" if attachment.uniformTypeIdentifier == "public.jpeg" else ".png"
            filename = f"{len(self.screenshots) + 1:02d}-{safe_name}{suffix}"
            output = self.result_directory / filename
            descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                os.write(descriptor, attachment.data)
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            self.screenshots.append({
                "file": filename,
                "bytes": len(attachment.data),
                "sha256": hashlib.sha256(attachment.data).hexdigest(),
            })


def write_result(path: Path, payload: dict[str, object]) -> None:
    encoded = (json.dumps(payload, sort_keys=True, indent=2) + "\n").encode()
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(descriptor, encoded)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


async def run(result_path: Path, requested: list[str]) -> int:
    if not requested or any(name not in ALLOWED_TESTS for name in requested):
        write_result(result_path, {
            "schemaVersion": "maina.ios-direct-xcuitest-result.v1",
            "status": "failed_closed",
            "reasonCode": "TEST_SELECTION_REJECTED",
            "device": "iphone15_usb_bound",
            "lifecycleMutationAttempts": 0,
        })
        return 64

    started = time.monotonic()
    listener = SanitizedListener(result_path.parent)
    rsd = None
    failure_stage = "native_rsd"
    try:
        rsd = await establish_native_rsd(serial=DEVICE_UDID)
        if rsd.udid != DEVICE_UDID:
            raise RuntimeError("device identity mismatch")

        failure_stage = "test_configuration"
        config = await TestConfig.create_for(rsd, RUNNER_BUNDLE_ID, TARGET_BUNDLE_ID)
        target = config.target_app_info or {}
        if target.get("CFBundleShortVersionString") != EXPECTED_VERSION:
            raise RuntimeError("target version mismatch")
        if str(target.get("CFBundleVersion")) != EXPECTED_BUILD:
            raise RuntimeError("target build mismatch")

        selected = [ALLOWED_TESTS[name] for name in requested]
        config.tests_to_run = selected
        failure_stage = "test_execution"
        await XCUITestService(rsd).run(config, timeout=300.0, listener=listener)

        expected_methods = {value.split("/", 1)[1] for value in selected}
        observed_methods = set(listener.cases)
        passed = (
            listener.plan_started
            and listener.plan_finished
            and not listener.initialization_failed
            and listener.failure_count == 0
            and observed_methods == expected_methods
            and all(case["status"] == "passed" for case in listener.cases.values())
        )
        payload: dict[str, object] = {
            "schemaVersion": "maina.ios-direct-xcuitest-result.v1",
            "status": "passed" if passed else "failed_closed",
            "reasonCode": "PASS" if passed else "TEST_RESULT_MISMATCH",
            "device": "iphone15_usb_bound",
            "runnerBundle": RUNNER_BUNDLE_ID,
            "targetBundle": TARGET_BUNDLE_ID,
            "targetVersion": EXPECTED_VERSION,
            "targetBuild": EXPECTED_BUILD,
            "requestedTests": requested,
            "cases": listener.cases,
            "planStarted": listener.plan_started,
            "planFinished": listener.plan_finished,
            "failureCount": listener.failure_count,
            "failureLocations": listener.failure_locations,
            "screenshots": listener.screenshots,
            "durationMs": round((time.monotonic() - started) * 1000),
            "rawDeviceOutputPersisted": False,
            "lifecycleMutationAttempts": 0,
        }
        write_result(result_path, payload)
        return 0 if passed else 1
    except Exception:
        reason = {
            "native_rsd": "DEVICE_TRANSPORT_UNAVAILABLE",
            "test_configuration": "TEST_CONFIGURATION_FAILED",
            "test_execution": "DIRECT_XCUITEST_FAILED",
        }[failure_stage]
        write_result(result_path, {
            "schemaVersion": "maina.ios-direct-xcuitest-result.v1",
            "status": "failed_closed",
            "reasonCode": reason,
            "failureStage": failure_stage,
            "device": "iphone15_usb_bound",
            "requestedTests": requested,
            "planStarted": listener.plan_started,
            "planFinished": listener.plan_finished,
            "failureCount": listener.failure_count,
            "failureLocations": listener.failure_locations,
            "durationMs": round((time.monotonic() - started) * 1000),
            "rawDeviceOutputPersisted": False,
            "lifecycleMutationAttempts": 0,
        })
        return 1
    finally:
        if rsd is not None:
            await rsd.close()


def main() -> int:
    if len(sys.argv) < 3:
        return 64
    logging.disable(logging.CRITICAL)
    result_path = Path(sys.argv[1])
    if not result_path.is_absolute() or result_path.exists():
        return 64
    return asyncio.run(run(result_path, sys.argv[2:]))


if __name__ == "__main__":
    raise SystemExit(main())
