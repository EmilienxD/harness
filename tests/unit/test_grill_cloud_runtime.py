import json
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).parents[2]
PACKAGE = ROOT / "harness/planning/grill-me-in-cloud"
sys.path.insert(0, str(PACKAGE))

import grill_cloud_core
import grill_me_in_cloud_hook
from grill_cloud_core import HostedClient, HostedError, InterviewRuntime, RoundError, discover_references, project_identity, validate_assets, validate_round


def round_data(html="<p>Context.</p>"):
    return {"questions": [{
        "id": "Q1", "question": "Where should this run?", "explanation_html": html,
        "recommendation": "A", "init_js": "root.dataset.ready = 'true'",
        "options": [
            {"letter": "A", "label": "Hosted", "detail": "Persist it remotely."},
            {"letter": "B", "label": "Local", "detail": "Keep it on one machine."},
        ],
    }]}


class HostedBoard:
    def __init__(self, fail=False):
        self.fail = fail
        self.keys = []
        self.requests = []
        self.uploads = []

    def request(self, method, path, body=None, idempotency_key=None):
        self.keys.append(idempotency_key)
        self.requests.append((method, path, body))
        if self.fail:
            raise HostedError("offline", "network_error")
        if path.endswith("/prepare"):
            return {"publication": {"id": "publication-id", "status": "prepared"}, "upload_targets": [
                {"reference": asset["reference"], "signed_url": "https://uploads.test/image"} for asset in body["assets"]
            ]}
        return {"round_number": 1, "url": "https://grill.test/?session=claude%3Asession"}

    def upload(self, target, path, media_type):
        self.uploads.append((target, path.read_bytes(), media_type))

    def session(self, provider, session_id):
        return None


def test_round_contract_and_html_image_discovery():
    payload = validate_round(round_data('<picture><source srcset="assets/round-001/a.webp 1x, https://cdn.test/a.webp 2x"><img src="assets/round-001/a&amp;b.png"></picture>'))
    assert discover_references(payload) == ["assets/round-001/a.webp", "https://cdn.test/a.webp", "assets/round-001/a&b.png"]
    with pytest.raises(RoundError):
        validate_round(round_data() | {"questions": [round_data()["questions"][0]] * 2})


def test_assets_are_bounded_to_the_round_and_content_checked(tmp_path):
    assets = tmp_path / "assets"
    assets.mkdir()
    image = assets / "diagram.png"
    image.write_bytes(b"\x89PNG\r\n\x1a\n" + b"payload")
    manifest = validate_assets(round_data('<img src="assets/round-001/diagram.png">'), assets, "assets/round-001/")
    assert [(item["media_type"], item["byte_size"]) for item in manifest] == [("image/png", 15)]
    with pytest.raises(RoundError):
        validate_assets(round_data('<img src="assets/round-001/../secret.png">'), assets, "assets/round-001/")


def test_publication_returns_immediately_and_reserves_the_next_inbox(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    client = HostedBoard()
    runtime = InterviewRuntime(tmp_path / "runtime", client)
    interview = runtime.start("claude", "session", project)
    interview.source.write_text(json.dumps(round_data()), encoding="utf-8")
    result = runtime.publish("claude", "session", project=project, home=tmp_path)
    assert result["round_number"] == 1
    prepared = next(body for method, path, body in client.requests if method == "POST" and path.endswith("/prepare"))
    assert prepared["project"] == {"name": "project", "path": str(Path("~") / "project")}
    assert runtime.current("claude", "session").source.name == "round-002.json"
    assert not list((tmp_path / "runtime" / "outbox").rglob("publication.json"))


def test_project_identity_replaces_the_home_directory_and_keeps_the_project_name(tmp_path):
    project = tmp_path / "work" / "same-name"
    assert project_identity(project, home=tmp_path) == {
        "name": "same-name",
        "path": str(Path("~") / "work" / "same-name"),
    }


def test_signed_storage_uploads_use_put(tmp_path, monkeypatch):
    image = tmp_path / "diagram.png"
    image.write_bytes(b"\x89PNG\r\n\x1a\n")
    seen = []

    class Response:
        def read(self):
            return b""

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

    monkeypatch.setattr(
        grill_cloud_core.urllib.request, "urlopen",
        lambda request, timeout=None: seen.append((request.get_method(), request.headers)) or Response(),
    )
    HostedClient("https://grill.test", "1234").upload({"signed_url": "https://uploads.test/x"}, image, "image/png")
    assert seen[0][0] == "PUT"


def test_retry_skips_assets_the_server_already_holds(tmp_path):
    project = tmp_path / "project"
    project.mkdir()

    class PartialBoard(HostedBoard):
        def request(self, method, path, body=None, idempotency_key=None):
            result = super().request(method, path, body, idempotency_key)
            if path.endswith("/prepare"):
                result["upload_targets"] = []
            return result

    runtime = InterviewRuntime(tmp_path / "runtime", PartialBoard())
    interview = runtime.start("claude", "session", project)
    assets = interview.assets
    (assets / "diagram.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    interview.source.write_text(json.dumps(round_data('<img src="assets/round-001/diagram.png">')), encoding="utf-8")
    assert runtime.publish("claude", "session")["round_number"] == 1
    assert runtime.client.uploads == []


def test_hook_stays_silent_for_sessions_that_never_used_grill(tmp_path, monkeypatch):
    monkeypatch.delenv("HARNESS_GRILL_URL", raising=False)
    monkeypatch.delenv("HARNESS_GRILL_CODE", raising=False)
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    event = {"session_id": "unrelated", "hook_event_name": "UserPromptSubmit", "prompt": "hello", "cwd": str(tmp_path)}
    assert grill_me_in_cloud_hook.handle(event, "claude") is None
    invoked = event | {"prompt": "/grill-me-in-cloud plan"}
    assert "not configured" in grill_me_in_cloud_hook.handle(invoked, "claude")["hookSpecificOutput"]["additionalContext"]


def test_project_config_overrides_stale_process_environment(tmp_path, monkeypatch):
    project = tmp_path / "project"
    config = project / ".harness" / "grill.json"
    config.parent.mkdir(parents=True)
    config.write_text(json.dumps({"url": "http://127.0.0.1:4173", "code": "2468"}), encoding="utf-8")
    monkeypatch.setenv("HARNESS_GRILL_URL", "http://localhost:8080/")
    monkeypatch.setenv("HARNESS_GRILL_CODE", "0000")

    client = HostedClient.from_environment(project)

    assert client.origin == "http://127.0.0.1:4173"
    assert client.code == "2468"


def test_failed_publication_keeps_one_idempotent_outbox_for_retry(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    client = HostedBoard(fail=True)
    runtime = InterviewRuntime(tmp_path / "runtime", client)
    interview = runtime.start("chatgpt", "session", project)
    interview.source.write_text(json.dumps(round_data()), encoding="utf-8")
    with pytest.raises(HostedError):
        runtime.publish("chatgpt", "session")
    publication = next((tmp_path / "runtime" / "outbox").rglob("publication.json"))
    key = json.loads(publication.read_text(encoding="utf-8"))["idempotency_key"]
    client.fail = False
    assert runtime.retry_pending("chatgpt", "session")[0]["round_number"] == 1
    assert all(candidate == key for candidate in client.keys if candidate is not None)
