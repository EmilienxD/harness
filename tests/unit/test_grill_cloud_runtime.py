import json
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).parents[2]
PACKAGE = ROOT / "harness/planning/grill-me-in-cloud"
sys.path.insert(0, str(PACKAGE))

import grill_me_in_cloud_hook
from grill_me_in_cloud_hook import HostedClient, HostedError, InterviewRuntime, RoundError, discover_references, project_identity, validate_assets, validate_round


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
        if isinstance(self.fail, HostedError):
            raise self.fail
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


def test_each_session_gets_a_short_distinct_inbox_that_survives_restarts(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    runtime = InterviewRuntime(tmp_path / "runtime")
    first = runtime.start("claude", "first", project).directory
    second = runtime.start("claude", "second", project).directory
    assert first != second and len(first.name) <= 8 and len(second.name) <= 8
    assert InterviewRuntime(tmp_path / "runtime").start("claude", "first", project).directory == first


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
        grill_me_in_cloud_hook.urllib.request, "urlopen",
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


def write_config(path, **grill):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"version": 1, "grill": grill}), encoding="utf-8")


@pytest.mark.parametrize("source", ["local", "user", "environment"])
def test_code_only_configuration_uses_the_production_board(tmp_path, monkeypatch, source):
    project = tmp_path / "project"
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "home"))
    monkeypatch.delenv("HARNESS_GRILL_URL", raising=False)
    monkeypatch.delenv("HARNESS_GRILL_CODE", raising=False)
    if source == "environment":
        monkeypatch.setenv("HARNESS_GRILL_CODE", "2468")
    else:
        path = project / ".harness" / "config.local.json" if source == "local" else tmp_path / "home" / "config.json"
        write_config(path, code="2468")

    client = HostedClient.from_environment(project)

    assert (client.origin, client.code) == ("https://grill-me-in-cloud.vercel.app", "2468")


def test_environment_url_overrides_the_production_board(tmp_path, monkeypatch):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "home"))
    monkeypatch.setenv("HARNESS_GRILL_URL", "http://localhost:8080")
    monkeypatch.setenv("HARNESS_GRILL_CODE", "2468")

    assert HostedClient.from_environment(tmp_path).origin == "http://localhost:8080"


def test_config_files_override_stale_process_environment(tmp_path, monkeypatch):
    project = tmp_path / "project"
    write_config(project / ".harness" / "config.local.json", url="http://127.0.0.1:4173", code="2468")
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "home"))
    monkeypatch.setenv("HARNESS_GRILL_URL", "http://localhost:8080/")
    monkeypatch.setenv("HARNESS_GRILL_CODE", "0000")

    client = HostedClient.from_environment(project)

    assert (client.origin, client.code) == ("http://127.0.0.1:4173", "2468")


def test_hook_reads_project_config_after_the_agent_changes_into_a_subdirectory(tmp_path, monkeypatch):
    project = tmp_path / "project"
    write_config(project / ".harness" / "config.local.json", url="https://project.test", code="2468")
    (project / "src").mkdir()
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("HARNESS_GRILL_URL", "http://127.0.0.1:4173")
    monkeypatch.setenv("HARNESS_GRILL_CODE", "0000")
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))
    captured = {}
    monkeypatch.setattr(grill_me_in_cloud_hook, "_handle", lambda payload, provider, runtime: captured.setdefault("client", runtime.client))

    grill_me_in_cloud_hook.handle(
        {"session_id": "session", "hook_event_name": "PostToolUse", "cwd": str(project / "src")}, "claude",
    )

    assert captured["client"].origin == "https://project.test"


def test_committed_project_config_supplies_the_url_but_never_the_code(tmp_path, monkeypatch):
    project = tmp_path / "project"
    write_config(project / ".harness" / "config.json", url="https://project.test", code="1111")
    write_config(tmp_path / "home" / "config.json", url="https://user.test", code="2468")
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "home"))

    client = HostedClient.from_environment(project)

    assert (client.origin, client.code) == ("https://project.test", "2468")


def test_project_config_without_a_code_source_is_not_configured(tmp_path, monkeypatch):
    project = tmp_path / "project"
    write_config(project / ".harness" / "config.json", url="https://project.test", code="1111")
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "home"))
    monkeypatch.delenv("HARNESS_GRILL_CODE", raising=False)

    with pytest.raises(ValueError):
        HostedClient.from_environment(project)


def test_config_files_require_the_shared_version_marker(tmp_path, monkeypatch):
    project = tmp_path / "project"
    (project / ".harness").mkdir(parents=True)
    (project / ".harness" / "config.local.json").write_text(json.dumps({"grill": {"code": "2468"}}), encoding="utf-8")
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "home"))

    with pytest.raises(ValueError, match="version-1"):
        HostedClient.from_environment(project)


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


def queued_publications(tmp_path):
    return list((tmp_path / "runtime" / "outbox").rglob("publication.json"))


def write_round(runtime, session, project, question="Where should this run?"):
    interview = runtime.start("claude", session, project)
    payload = round_data()
    payload["questions"][0]["question"] = question
    interview.source.write_text(json.dumps(payload), encoding="utf-8")


@pytest.mark.parametrize(("failure", "queued"), [
    (HostedError("offline", "network_error"), True),
    (HostedError("Server error", "commit_failed", 500), True),
    (HostedError("Too many attempts", "too_many_attempts", 429), True),
    (HostedError("Access is required.", "unauthorized", 401), False),
    (HostedError("The publication payload is invalid.", "invalid_payload", 422), False),
])
def test_only_transient_publication_failures_stay_queued(tmp_path, failure, queued):
    project = tmp_path / "project"
    project.mkdir()
    runtime = InterviewRuntime(tmp_path / "runtime", HostedBoard(fail=failure))
    write_round(runtime, "session", project)
    with pytest.raises(HostedError) as raised:
        runtime.publish("claude", "session")
    assert raised.value.retryable is queued
    assert bool(queued_publications(tmp_path)) is queued


def test_a_newer_round_replaces_a_queued_one_so_it_never_supersedes_it(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    client = HostedBoard(fail=True)
    runtime = InterviewRuntime(tmp_path / "runtime", client)
    write_round(runtime, "session", project, "Stale question?")
    with pytest.raises(HostedError):
        runtime.publish("claude", "session")
    client.fail = False
    client.requests.clear()
    write_round(runtime, "session", project, "Current question?")
    runtime.publish("claude", "session")
    assert runtime.retry_pending("claude", "session") == []
    prepared = [body["payload"]["questions"][0]["question"] for _, path, body in client.requests if path.endswith("/prepare")]
    assert prepared == ["Current question?"]


def hook_event(project, event, **fields):
    return {"session_id": "session", "hook_event_name": event, "cwd": str(project)} | fields


def hook_context(result):
    return result["hookSpecificOutput"]["additionalContext"]


def test_queued_rounds_retry_on_the_next_user_message_not_on_every_tool_call(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    client = HostedBoard(fail=True)
    runtime = InterviewRuntime(tmp_path / "runtime", client)
    write_round(runtime, "session", project)
    grill_me_in_cloud_hook.handle(hook_event(project, "PostToolUse", tool_name="Write", tool_input={}), "claude", runtime)
    assert queued_publications(tmp_path)
    client.fail = False
    client.requests.clear()

    tool_call = hook_event(project, "PostToolUse", tool_name="Read", tool_input={})
    assert grill_me_in_cloud_hook.handle(tool_call, "claude", runtime) is None
    assert client.requests == []

    reply = hook_context(grill_me_in_cloud_hook.handle(hook_event(project, "UserPromptSubmit", prompt="retry"), "claude", runtime))
    assert not queued_publications(tmp_path)
    assert "https://grill.test/?session=claude%3Asession" in reply
    assert str(runtime.current("claude", "session").source) in reply


def test_a_board_outage_stays_silent_in_sessions_that_are_not_grilling(tmp_path):
    class OfflineBoard(HostedBoard):
        def session(self, provider, session_id):
            raise HostedError("offline", "network_error")

    project = tmp_path / "project"
    project.mkdir()
    runtime = InterviewRuntime(tmp_path / "runtime", OfflineBoard())
    assert grill_me_in_cloud_hook.handle(hook_event(project, "UserPromptSubmit", prompt="hello"), "claude", runtime) is None


def test_a_permanently_rejected_queued_round_ends_the_interview_without_a_new_path(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    client = HostedBoard(fail=True)
    runtime = InterviewRuntime(tmp_path / "runtime", client)
    write_round(runtime, "session", project)
    grill_me_in_cloud_hook.handle(hook_event(project, "PostToolUse", tool_name="Write", tool_input={}), "claude", runtime)
    client.fail = HostedError("Access is required.", "unauthorized", 401)

    reply = hook_context(grill_me_in_cloud_hook.handle(hook_event(project, "UserPromptSubmit", prompt="retry"), "claude", runtime))
    assert not queued_publications(tmp_path)
    assert str(runtime.current("claude", "session").directory) not in reply
