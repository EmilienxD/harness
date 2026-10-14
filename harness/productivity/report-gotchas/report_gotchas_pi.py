"""Pi transport only; the installed shared runtime owns reports and delivery."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from report_gotchas.config import webhook_url
from report_gotchas.hooks import _launch_worker
from report_gotchas.reports import ReportError, queued_receipts, state_dir, submit_pi


def main() -> int:
    try:
        request = json.load(sys.stdin)
        if request.get("version") != 1:
            raise ReportError("Pi report protocol mismatch")
        url = webhook_url()
        configured = url is not None
        # Share user configuration, but isolate Pi queues from independently pinned legacy
        # CLI retry workers that predate delivery locks and native submission identities.
        os.environ["HARNESS_REPORT_GOTCHAS_STATE_DIR"] = str(state_dir() / "pi")
        if url is not None:
            os.environ["HARNESS_REPORT_GOTCHAS_WEBHOOK_URL"] = url
        operation = request.get("operation")
        if operation == "submit":
            message = request.get("message")
            session_id = request.get("sessionId")
            if not isinstance(message, str) or not isinstance(session_id, str):
                raise ReportError("invalid Pi report request")
            receipt, duplicate = submit_pi(message, session_id, Path(request["cwd"]))
            warning = ""
            try:
                if receipt in queued_receipts():
                    _launch_worker(receipt)
            except OSError:
                warning = " Worker could not start; use /report-gotchas-retry."
            print(json.dumps({"version": 1, "receipt": receipt, "duplicate": duplicate,
                              "configured": configured, "warning": warning}))
        elif operation == "retry":
            if not configured:
                raise ReportError("Discord webhook is not configured; run harness-report-gotchas configure")
            receipts = queued_receipts()
            for receipt in receipts:
                _launch_worker(receipt)
            print(json.dumps({"version": 1, "scheduled": len(receipts)}))
        else:
            raise ReportError("unknown Pi report operation")
    except (ReportError, OSError, ValueError, KeyError, TypeError):
        # Requests may carry private report text; never echo them in diagnostics.
        print("Pi report operation failed; check runtime, queue and webhook configuration.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
