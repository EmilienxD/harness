"""Pi's bounded native preparation/publication adapter; the shared core owns rounds."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from grill_me_in_cloud_hook import (
    HostedError, InterviewRuntime, RoundError, atomic_write, instructions, project_identity,
)


class PiInterviewRuntime(InterviewRuntime):
    """Bind queued publication recovery to the native session file and active ancestry."""

    def bind(self, request: dict) -> None:
        self.session_file = request["sessionFile"]
        self.anchor = request["anchor"]
        self.branch_ids = set(request["branchIds"])
        if not isinstance(self.session_file, str) or not self.session_file or self.anchor not in self.branch_ids:
            raise ValueError("Missing Pi publication ancestry")

    def _stage(self, *args, **kwargs) -> Path:
        publication = super()._stage(*args, **kwargs)
        staged = json.loads(publication.read_text(encoding="utf-8"))
        staged["pi_session_file"] = self.session_file
        staged["pi_anchor"] = self.anchor
        atomic_write(publication, json.dumps(staged, ensure_ascii=False))
        return publication

    def retry_pending(self, provider: str, session: str) -> list[dict]:
        results = []
        for publication in self._outboxes(provider, session):
            staged = json.loads(publication.read_text(encoding="utf-8"))
            if staged.get("pi_session_file") == self.session_file and staged.get("pi_anchor") in self.branch_ids:
                results.append(self._publish_staged(publication))
        return results


def handle(request: dict) -> dict:
    if request.get("version") != 1 or request.get("operation") not in {"prepare", "publish"}:
        raise ValueError("Unsupported Pi grill request")
    session = request["sessionId"]
    if not isinstance(session, str) or not session:
        raise ValueError("Missing native Pi session identity")
    project = Path(request["cwd"]).resolve()
    runtime = PiInterviewRuntime.from_environment(project=project)
    # A fresh input can precede the first native entry. Publication itself always has an anchor.
    if request["operation"] == "publish" or request.get("anchor"):
        runtime.bind(request)
    else:
        runtime.session_file = request.get("sessionFile")
        runtime.anchor = None
        runtime.branch_ids = set()
    if runtime.client is None:
        return {"version": 1, "ok": False, "message": runtime.configuration_error}
    try:
        # An older service must fail before model inference, rather than mislabel Pi as Codex.
        capabilities = runtime.client.request("GET", "/api/v1/capabilities")
        if "pi" not in capabilities.get("providers", []) or capabilities.get("pi_relay") != 1:
            raise HostedError("This board does not support Pi. Upgrade the hosted app and database.", "unsupported_provider", 422)
        with runtime.claim("pi", session) as acquired:
            if not acquired:
                raise ValueError("This Pi interview is busy; retry after the current operation")
            published = None
            if request["operation"] == "prepare":
                queued = runtime.retry_pending("pi", session)
                published = queued[-1] if queued else None
                interview = runtime.start("pi", session, project)
            else:
                interview = runtime.current("pi", session)
                if interview is None:
                    raise ValueError("Start /grill-me-in-cloud before publishing a round")
                published = runtime.publish("pi", session, request.get("title") or session, project=project)
                interview = runtime.current("pi", session)
            message = instructions(interview)
            if published:
                message = (
                    f"Round {published['round_number']} was published: {published['url']}\n"
                    'Only reply "Round available at: <URL>" with this URL, then end your turn. '
                    "The board's Send to Pi action returns the user's reviewed answers to this session.\n\n"
                    + message
                )
            return {
                "version": 1, "ok": True, "message": message,
                "published": published, "source": str(interview.source),
                "relay": {"origin": runtime.client.origin, "code": runtime.client.code,
                          "directory": str(runtime.root / "pi-relay"), "workspace": project_identity(project)},
            }
    except RoundError as error:
        interview = runtime.current("pi", session)
        return {"version": 1, "ok": False, "source": str(interview.source),
                "message": f"Round rejected: {error}\n{instructions(interview)}"}
    except HostedError as error:
        if error.status == 404:
            message = "This board does not support Pi. Upgrade the hosted app and database."
        else:
            message = str(error)
        if error.retryable and runtime._outboxes("pi", session):
            message += " The round is queued and retries on the next user message"
        return {"version": 1, "ok": False, "message": f"Hosted grill failed: {message}. Tell the user and stop."}


if __name__ == "__main__":
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        print(json.dumps(handle(json.load(sys.stdin))))
    except Exception:
        # Configuration and credentials stay out of model-facing diagnostics.
        print(json.dumps({"version": 1, "ok": False, "message": "Pi grill setup failed. Check Harness configuration and the Python runtime."}))
