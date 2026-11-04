"""Pi's bounded native preparation/publication adapter; the shared core owns rounds."""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from grill_me_in_cloud_hook import (
    HostedError, InterviewRuntime, RoundError, atomic_write, locations, publication_result, project_identity,
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
        atomic_write(publication, json.dumps(staged, ensure_ascii=True))
        return publication

    def retry_pending(self, provider: str, session: str) -> list[dict]:
        results = []
        for publication in self._outboxes(provider, session):
            staged = json.loads(publication.read_text(encoding="utf-8"))
            if staged.get("pi_session_file") == self.session_file and staged.get("pi_anchor") in self.branch_ids:
                results.append(self._publish_staged(publication))
        return results

    def _record_publication(self, staged: dict, result: dict) -> None:
        receipt = {
            "session_file": staged["pi_session_file"], "anchor": staged["pi_anchor"],
            "origin": self.client.origin, "published": result, "committed_at": time.time_ns(),
        }
        path = self.root / "pi-publications" / self.key("pi", staged["session_id"]) / f"{staged['idempotency_key']}.json"
        atomic_write(path, json.dumps(receipt, ensure_ascii=True))

    def recover_publication(self, session: str) -> dict | None:
        directory = self.root / "pi-publications" / self.key("pi", session)
        receipts = [json.loads(path.read_text(encoding="utf-8")) for path in directory.glob("*.json")]
        eligible = [receipt for receipt in receipts if receipt["session_file"] == self.session_file
                    and receipt["anchor"] in self.branch_ids and receipt["origin"] == self.client.origin]
        if not eligible:
            return None
        receipt = max(eligible, key=lambda item: item["committed_at"])
        published = receipt["published"]
        detail = self.client.session("pi", session)
        if not detail or detail["session"]["provider_session_id"] != session:
            return None
        if not any(item["id"] == published["round_id"] and item["status"] == "active" for item in detail["rounds"]):
            return None
        return published


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
            previous = runtime.current("pi", session)
            if request["operation"] == "prepare":
                queued = runtime.retry_pending("pi", session)
                published = queued[-1] if queued else runtime.recover_publication(session)
                interview = runtime.start("pi", session, project)
            else:
                interview = runtime.current("pi", session)
                if interview is None:
                    raise ValueError("Start /grill-me-in-cloud before publishing a round")
                published = runtime.publish("pi", session, request.get("title") or session, project=project)
                interview = runtime.current("pi", session)
            changed = previous is None or previous.source != interview.source
            message = locations(interview) if request.get("initial") or changed or request["operation"] == "publish" else ""
            if published and (request["operation"] == "publish" or published["round_id"] not in request.get("confirmedRoundIds", [])):
                message = f"{publication_result(published)}\n{locations(interview)}"
            return {
                "version": 1, "ok": True, "message": message,
                "published": published, "source": str(interview.source),
                "relay": {"origin": runtime.client.origin, "code": runtime.client.code,
                          "directory": str(runtime.root / "pi-relay"), "workspace": project_identity(project)},
            }
    except RoundError as error:
        interview = runtime.current("pi", session)
        return {"version": 1, "ok": False, "source": str(interview.source),
                "message": f"Round rejected: {error}\n{locations(interview)}"}
    except HostedError as error:
        if error.status == 404:
            message = "This board does not support Pi. Upgrade the hosted app and database."
        else:
            message = str(error)
        if error.retryable and runtime._outboxes("pi", session):
            message += " The round is queued and retries on the next user message"
        return {"version": 1, "ok": False, "message": f"Hosted grill failed: {message}"}


if __name__ == "__main__":
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        print(json.dumps(handle(json.load(sys.stdin))))
    except Exception:
        # Configuration and credentials stay out of model-facing diagnostics.
        print(json.dumps({"version": 1, "ok": False, "message": "Pi grill setup failed. Check Harness configuration and the Python runtime."}))
