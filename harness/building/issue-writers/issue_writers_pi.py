"""Native Pi draft identity and deterministic publishing adapter."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import uuid

import issues_core as core


def issues_session_id(native_id: str) -> str:
    if not native_id:
        raise ValueError("Missing native Pi session identity")
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"harness:issues:pi:{native_id}"))


def evaluate(request: dict) -> dict:
    if request["version"] != 1:
        raise ValueError("Unsupported Pi issue writer request")
    cwd = Path(request["cwd"]).resolve()
    os.chdir(cwd)
    session = issues_session_id(request["sessionId"])
    if request["operation"] == "publish":
        message = core.run_publish_command("/publish-issues " + request["argument"], session, cwd)
    elif request["operation"] == "notice":
        message = core.flush_notice(cwd, session) or ""
    elif request["operation"] == "prepare" and request["skill"] in {
        "draft-issue", "draft-issues", "to-spec", "to-spec-draft-issue",
    }:
        context = "" if request["skill"] == "to-spec" else core.prepare_drafting_context(cwd, session)
        notice = core.flush_notice(cwd, session)
        message = "\n\n".join(item for item in (notice, context) if item)
    else:
        raise ValueError("Unknown Pi issue writer operation")
    return {"version": 1, "ok": True, "message": message}


def main() -> None:
    try:
        response = evaluate(json.load(sys.stdin))
    except Exception as error:
        response = {"version": 1, "ok": False, "message": f"Issue workflow stopped: {error}"}
    json.dump(response, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
