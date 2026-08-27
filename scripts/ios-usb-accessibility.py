#!/usr/bin/env python3
"""List or activate accessibility elements on one explicitly selected USB iPhone.

This is a staging-only physical-device qualification helper. It intentionally
requires the target UDID so an automation run cannot silently select another
phone attached to the Mac.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from typing import Any

from pymobiledevice3.remote import native_tunnel
from pymobiledevice3.services.accessibilityaudit import AccessibilityAudit


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--udid", required=True)
    parser.add_argument("--press", help="Case-insensitive caption substring to activate")
    parser.add_argument("--exact", action="store_true", help="Require an exact caption match")
    args = parser.parse_args()

    provider = await native_tunnel.establish_native_rsd(serial=args.udid)
    try:
        async with AccessibilityAudit(provider) as audit:
            elements: list[dict[str, Any]] = []
            target = None
            async for element in audit.iter_elements():
                item = element.to_dict()
                elements.append(item)
                if args.press and target is None:
                    caption = (element.caption or "").casefold()
                    query = args.press.casefold()
                    matched = caption == query if args.exact else query in caption
                    if matched:
                        target = element

            if not args.press:
                print(json.dumps(elements, indent=2, ensure_ascii=False))
                return 0
            if target is None or target.element is None:
                print(json.dumps({"pressed": False, "query": args.press, "elements": elements}, ensure_ascii=False))
                return 2

            await audit.perform_press(target.element.identifier)
            # The daemon acknowledges activation out-of-band. Keep the DTX
            # channel alive briefly so the fire-and-forget action is delivered.
            await asyncio.sleep(0.75)
            print(json.dumps({"pressed": True, "caption": target.caption}, ensure_ascii=False))
            return 0
    finally:
        await provider.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
