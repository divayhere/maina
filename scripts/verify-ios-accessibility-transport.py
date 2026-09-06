#!/usr/bin/env python3
"""Zero-device contract test for the iOS accessibility transport helper."""

from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path
from typing import Any


HELPER = Path(__file__).with_name("ios-usb-accessibility.py")


def load_helper() -> Any:
    spec = importlib.util.spec_from_file_location("maina_ios_accessibility", HELPER)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def verify() -> None:
    helper = load_helper()
    events: list[tuple[str, Any]] = []
    provider = object()
    audit = object()

    class FakeTunnel:
        def __init__(self, *, serial: str) -> None:
            events.append(("tunnel_init", serial))

        async def __aenter__(self) -> Any:
            events.append(("tunnel_enter", provider))
            return provider

        async def __aexit__(self, *args: Any) -> None:
            events.append(("tunnel_exit", None))

    class FakeAudit:
        def __init__(self, actual_provider: Any) -> None:
            assert actual_provider is provider
            events.append(("audit_init", actual_provider))

        async def __aenter__(self) -> Any:
            events.append(("audit_enter", audit))
            return audit

        async def __aexit__(self, *args: Any) -> None:
            events.append(("audit_exit", None))

    async def operation(actual_audit: Any) -> str:
        assert actual_audit is audit
        events.append(("operation", actual_audit))
        return "ok"

    result = await helper.with_accessibility_audit(
        "exact-test-udid",
        operation,
        tunnel_factory=FakeTunnel,
        audit_factory=FakeAudit,
    )
    assert result == "ok"
    assert [event for event, _ in events] == [
        "tunnel_init",
        "tunnel_enter",
        "audit_init",
        "audit_enter",
        "operation",
        "audit_exit",
        "tunnel_exit",
    ]

    source = HELPER.read_text(encoding="utf-8")
    assert "PreferredRsdTunnel" in source
    assert "establish_native_rsd" not in source
    assert "native_tunnel" not in source


if __name__ == "__main__":
    asyncio.run(verify())
    print("iOS accessibility preferred-RSD transport contract verified (zero device commands).")
