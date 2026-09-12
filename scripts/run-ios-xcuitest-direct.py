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

from pymobiledevice3.exceptions import ConnectionTerminatedError
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
EXPECTED_VERSION = "0.10.70"
EXPECTED_BUILD = "52"
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
CASE_TIMEOUT_SECONDS = {
    "navigation-audit": 60.0,
    "short-recording-lifecycle": 90.0,
    "rapid-pause-resume": 60.0,
    "paused-state": 60.0,
    "background-recording": 90.0,
    "discard-recording": 60.0,
    "process-death-recovery": 150.0,
    "long-recording": 180.0,
}


class SanitizedListener(XCUITestListener):
    def __init__(self, result_directory: Path, case_name: str) -> None:
        self.case_name = case_name
        self.expected_method = ALLOWED_TESTS[case_name].split("/", 1)[1]
        self.plan_started = False
        self.plan_finished = False
        self.case_started = False
        self.cases: dict[str, dict[str, object]] = {}
        self.failure_count = 0
        self.failure_locations: list[dict[str, object]] = []
        self.stall_count = 0
        self.stall_locations: list[dict[str, object]] = []
        self.unexpected_event_count = 0
        self.initialization_failed = False
        self.result_directory = result_directory
        self.screenshots: list[dict[str, object]] = []

    async def did_begin_executing_test_plan(self) -> None:
        self.plan_started = True

    async def did_finish_executing_test_plan(self) -> None:
        self.plan_finished = True

    async def test_case_did_start(self, test_class: str, method: str) -> None:
        method_name = method.removesuffix("()")
        if method_name == self.expected_method:
            self.case_started = True
        else:
            self.unexpected_event_count += 1

    async def test_case_did_finish(self, result: XCTestCaseResult) -> None:
        method = result.method.removesuffix("()")
        if method != self.expected_method:
            self.unexpected_event_count += 1
            return
        self.cases[method] = {
            "status": result.status,
            "durationMs": round(result.duration * 1000),
        }

    async def test_case_did_fail(
        self, test_class: str, method: str, message: str, file: str, line: int
    ) -> None:
        if method.removesuffix("()") != self.expected_method:
            self.unexpected_event_count += 1
            return
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

    async def test_case_did_stall(
        self, test_class: str, method: str, file: str, line: int
    ) -> None:
        if method.removesuffix("()") != self.expected_method:
            self.unexpected_event_count += 1
            return
        self.stall_count += 1
        source_name = Path(file).name
        if source_name == "MainaUITests.swift" and isinstance(line, int) and 1 <= line <= 10_000:
            self.stall_locations.append({
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
        if method.removesuffix("()") != self.expected_method:
            self.unexpected_event_count += 1
            return
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
            filename = f"{self.case_name}-{len(self.screenshots) + 1:02d}-{safe_name}{suffix}"
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


def case_plan(requested: list[str]) -> list[tuple[str, str, float]]:
    if not requested or any(name not in ALLOWED_TESTS for name in requested):
        raise ValueError("invalid test selection")
    if len(set(requested)) != len(requested):
        raise ValueError("duplicate test selection")
    if set(CASE_TIMEOUT_SECONDS) != set(ALLOWED_TESTS):
        raise RuntimeError("test timeout policy is incomplete")
    return [(name, ALLOWED_TESTS[name], CASE_TIMEOUT_SECONDS[name]) for name in requested]


def execution_exception_code(error: Exception) -> str:
    if isinstance(error, TimeoutError):
        return "CASE_TIMEOUT"
    if isinstance(error, ConnectionTerminatedError):
        return "DTX_DISCONNECTED"
    return "CASE_EXECUTION_ERROR"


def sanitized_case_result(
    listener: SanitizedListener,
    host_duration_ms: int,
    error: Exception | None = None,
) -> dict[str, object]:
    observed = listener.cases.get(listener.expected_method)
    if error is not None:
        reason = execution_exception_code(error)
    elif listener.initialization_failed:
        reason = "BOOTSTRAP_FAILED"
    elif listener.unexpected_event_count != 0:
        reason = "UNEXPECTED_TEST_EVENT"
    elif listener.failure_count != 0 or (observed is not None and observed["status"] == "failed"):
        reason = "ASSERTION_FAILED"
    elif (
        listener.plan_started
        and listener.plan_finished
        and listener.case_started
        and observed is not None
        and observed["status"] == "passed"
    ):
        reason = "PASS"
    else:
        reason = "CASE_RESULT_MISMATCH"
    return {
        "status": "passed" if reason == "PASS" else "failed_closed",
        "reasonCode": reason,
        "timeoutSeconds": CASE_TIMEOUT_SECONDS[listener.case_name],
        "hostDurationMs": host_duration_ms,
        "planStarted": listener.plan_started,
        "planFinished": listener.plan_finished,
        "caseStarted": listener.case_started,
        "caseFinished": observed is not None,
        "testStatus": None if observed is None else observed["status"],
        "testDurationMs": None if observed is None else observed["durationMs"],
        "failureCount": listener.failure_count,
        "failureLocations": listener.failure_locations,
        "stallCount": listener.stall_count,
        "stallLocations": listener.stall_locations,
        "unexpectedEventCount": listener.unexpected_event_count,
        "initializationFailed": listener.initialization_failed,
        "screenshots": listener.screenshots,
    }


def write_result(path: Path, payload: dict[str, object]) -> None:
    encoded = (json.dumps(payload, sort_keys=True, indent=2) + "\n").encode()
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(descriptor, encoded)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


async def run(result_path: Path, requested: list[str]) -> int:
    try:
        selected_cases = case_plan(requested)
    except (RuntimeError, ValueError):
        write_result(result_path, {
            "schemaVersion": "maina.ios-direct-xcuitest-result.v2",
            "status": "failed_closed",
            "reasonCode": "TEST_SELECTION_REJECTED",
            "device": "iphone15_usb_bound",
            "lifecycleMutationAttempts": 0,
        })
        return 64

    started = time.monotonic()
    rsd = None
    failure_stage = "native_rsd"
    case_results: dict[str, dict[str, object]] = {}
    active_case: str | None = None
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

        failure_stage = "test_execution"
        for case_name, method, timeout_seconds in selected_cases:
            active_case = case_name
            listener = SanitizedListener(result_path.parent, case_name)
            case_config = TestConfig(
                runner_app_info=config.runner_app_info,
                target_app_info=config.target_app_info,
            )
            case_config.tests_to_run = [method]
            case_started = time.monotonic()
            execution_error: Exception | None = None
            try:
                await XCUITestService(rsd).run(
                    case_config,
                    timeout=timeout_seconds,
                    listener=listener,
                )
            except Exception as error:
                execution_error = error
            case_results[case_name] = sanitized_case_result(
                listener,
                round((time.monotonic() - case_started) * 1000),
                execution_error,
            )
            if execution_error is not None:
                break
        active_case = None

        passed = (
            len(case_results) == len(selected_cases)
            and all(case["status"] == "passed" for case in case_results.values())
        )
        first_failure = next(
            (case["reasonCode"] for case in case_results.values() if case["status"] != "passed"),
            None,
        )
        payload: dict[str, object] = {
            "schemaVersion": "maina.ios-direct-xcuitest-result.v2",
            "status": "passed" if passed else "failed_closed",
            "reasonCode": "PASS" if passed else (first_failure or "SHARDED_PLAN_INCOMPLETE"),
            "device": "iphone15_usb_bound",
            "runnerBundle": RUNNER_BUNDLE_ID,
            "targetBundle": TARGET_BUNDLE_ID,
            "targetVersion": EXPECTED_VERSION,
            "targetBuild": EXPECTED_BUILD,
            "requestedTests": requested,
            "completedCaseCount": len(case_results),
            "cases": case_results,
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
            "schemaVersion": "maina.ios-direct-xcuitest-result.v2",
            "status": "failed_closed",
            "reasonCode": reason,
            "failureStage": failure_stage,
            "device": "iphone15_usb_bound",
            "requestedTests": requested,
            "activeCase": active_case,
            "completedCaseCount": len(case_results),
            "cases": case_results,
            "durationMs": round((time.monotonic() - started) * 1000),
            "rawDeviceOutputPersisted": False,
            "lifecycleMutationAttempts": 0,
        })
        return 1
    finally:
        if rsd is not None:
            await rsd.close()


def self_test() -> int:
    plan = case_plan(list(ALLOWED_TESTS))
    assert len(plan) == 8
    assert plan[0] == ("navigation-audit", "MainaUITests/testNavigationAudit", 60.0)
    assert plan[-1] == ("long-recording", "MainaUITests/testLongRecordingWithBackgroundAndPauses", 180.0)
    assert sum(entry[2] for entry in plan) == 750.0
    for invalid in ([], ["unknown"], ["navigation-audit", "navigation-audit"]):
        try:
            case_plan(invalid)
        except ValueError:
            pass
        else:
            raise AssertionError("invalid test plan was accepted")
    listener = SanitizedListener(Path("."), "navigation-audit")
    listener.plan_started = True
    listener.case_started = True
    timeout_result = sanitized_case_result(listener, 60_001, TimeoutError())
    assert timeout_result["reasonCode"] == "CASE_TIMEOUT"
    disconnect_result = sanitized_case_result(listener, 1_000, ConnectionTerminatedError("closed"))
    assert disconnect_result["reasonCode"] == "DTX_DISCONNECTED"
    listener.plan_finished = True
    listener.cases[listener.expected_method] = {"status": "passed", "durationMs": 1_000}
    passed_result = sanitized_case_result(listener, 1_100)
    assert passed_result["status"] == "passed"
    assert passed_result["reasonCode"] == "PASS"
    print("iOS direct XCUITest sharding self-test PASS (8 plans, 5 adversaries)")
    return 0


def main() -> int:
    if sys.argv[1:] == ["--self-test"]:
        return self_test()
    if len(sys.argv) < 3:
        return 64
    logging.disable(logging.CRITICAL)
    result_path = Path(sys.argv[1])
    if not result_path.is_absolute() or result_path.exists():
        return 64
    return asyncio.run(run(result_path, sys.argv[2:]))


if __name__ == "__main__":
    raise SystemExit(main())
