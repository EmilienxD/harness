"""Small native Pi transport for the shared operating-system notifier."""
from __future__ import annotations

import json
import sys

from desktop_notification import backend_available, send_notification


def main() -> None:
    request = json.load(sys.stdin)
    try:
        if request.get("version") != 1:
            raise ValueError("Unsupported notification protocol")
        if request.get("operation") == "available":
            ok = backend_available()
        elif request.get("operation") == "notify":
            title, body = request.get("title"), request.get("body")
            if not isinstance(title, str) or not isinstance(body, str):
                raise ValueError("Notification text must be strings")
            send_notification(title, body)
            ok = True
        else:
            raise ValueError("Unknown notification operation")
    except Exception:
        ok = False
    print(json.dumps({"version": 1, "ok": ok}))


if __name__ == "__main__":
    main()
