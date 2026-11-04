import json
import io
import hashlib
import shutil
import subprocess
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


def test_dynamic_media_attributes_are_discovered_without_treating_choices_as_files():
    payload = round_data('<select><option value="A">Choose</option>'
                         '<option value="assets/round-001/alternate&amp;wide.png">Preview</option></select>'
                         '<a href="assets/round-001/full.png">Full size</a>'
                         '<button data-preview="assets/round-001/lazy.png">Load</button>'
                         '<img src="assets/round-001/alternate&amp;wide.png">'
                         '<pre>&lt;img src="assets/round-001/example.png"&gt;</pre>')
    assert discover_references(payload) == [
        "assets/round-001/alternate&wide.png", "assets/round-001/full.png", "assets/round-001/lazy.png",
    ]


@pytest.mark.parametrize("attribute", ["value", "href", "data-preview"])
@pytest.mark.parametrize("reference", ["assets/round-001/missing.png", "assets/round-001/../outside.png"])
def test_dynamic_media_must_exist_inside_the_round(tmp_path, attribute, reference):
    (tmp_path.parent / "outside.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    with pytest.raises(RoundError):
        validate_assets(round_data(f'<option {attribute}="{reference}">Preview</option>'), tmp_path, "assets/round-001/")


@pytest.mark.parametrize("provider", ["claude", "chatgpt", "pi"])
def test_publisher_uploads_every_dropdown_preview_and_enforces_asset_count(tmp_path, provider):
    project = tmp_path / "project"
    project.mkdir()
    client = HostedBoard()
    runtime = InterviewRuntime(tmp_path / "runtime", client)
    interview = runtime.start(provider, "session", project)
    references = [f"{interview.assets_url}preview-{index}.png" for index in range(31)]
    for reference in references:
        (interview.directory / reference).write_bytes(b"\x89PNG\r\n\x1a\n")
    html = '<select>' + ''.join(f'<option value="{ref}">Preview</option>' for ref in references[:30]) + '</select>'
    payload = round_data(html)
    interview.source.write_text(json.dumps(payload), encoding="utf-8")
    runtime.publish(provider, "session")
    prepared = next(body for method, path, body in client.requests if path.endswith("/prepare"))
    assert [asset["reference"] for asset in prepared["assets"]] == references[:30]
    assert len(client.uploads) == 30
    with pytest.raises(RoundError, match="30 local assets"):
        validate_assets(round_data(html + f'<img src="{references[30]}">'), interview.assets, interview.assets_url)


def diagram_figure(identity="flow", source="flowchart LR\n A --&gt; B", caption="Publish last"):
    return f'<figure data-grill-diagram="{identity}"><pre class="mermaid">{source}</pre><figcaption>{caption}</figcaption></figure>'


def test_diagram_extraction_decodes_source_and_keeps_explicit_identity():
    html = '<p>Context</p>' + diagram_figure("second", 'flowchart LR\r\n A["Read &amp; write&lt;br/&gt;assets"] --&gt; B', '<strong>Publish</strong> last') + diagram_figure("first")
    assert grill_me_in_cloud_hook.discover_diagrams(html) == [
        {"id": "second", "source": 'flowchart LR\n A["Read & write<br/>assets"] --> B', "caption": "Publish last"},
        {"id": "first", "source": "flowchart LR\n A --> B", "caption": "Publish last"},
    ]
    payload = round_data(html)
    assert validate_round(payload) == payload
    assert grill_me_in_cloud_hook.discover_diagrams('<pre class="mermaid">legacy</pre><code>&lt;figure data-grill-diagram="sample"&gt;</code><script>const sample = `<figure data-grill-diagram="script">`</script>') == []


@pytest.mark.parametrize("html", [
    diagram_figure() + diagram_figure(), diagram_figure("1bad"), diagram_figure("bad id"),
    diagram_figure("x", " "), diagram_figure("x", "graph TD", " "), diagram_figure("x", "A<br>B"),
    '<div data-grill-diagram="x"></div>',
    '<figure data-grill-diagram="outer">' + diagram_figure("inner") + '</figure>',
])
def test_diagram_validation_rejects_ambiguous_or_incomplete_figures(html):
    with pytest.raises(RoundError):
        validate_round(round_data(html))


@pytest.mark.parametrize("provider", ["claude", "chatgpt", "pi"])
def test_diagrams_publish_without_assets_or_initialization_javascript(tmp_path, provider):
    project = tmp_path / "project"
    project.mkdir()
    client = HostedBoard()
    runtime = InterviewRuntime(tmp_path / "runtime", client)
    interview = runtime.start(provider, "session", project)
    payload = round_data(diagram_figure() + diagram_figure("other"))
    del payload["questions"][0]["init_js"]
    payload["questions"].append(payload["questions"][0] | {"id": "Q2"})
    interview.source.write_text(json.dumps(payload), encoding="utf-8")
    result = runtime.publish(provider, "session")
    assert result["question_count"] == 2
    prepared = next(body for method, path, body in client.requests if method == "POST" and path.endswith("/prepare"))
    assert prepared["payload"]["questions"] == payload["questions"]
    assert prepared["assets"] == []
    assert client.uploads == []


def test_assets_are_bounded_to_the_round_and_content_checked(tmp_path):
    assets = tmp_path / "assets"
    assets.mkdir()
    image = assets / "diagram.png"
    image.write_bytes(b"\x89PNG\r\n\x1a\n" + b"payload")
    manifest = validate_assets(round_data('<img src="assets/round-001/diagram.png">'), assets, "assets/round-001/")
    assert [(item["media_type"], item["byte_size"]) for item in manifest] == [("image/png", 15)]
    with pytest.raises(RoundError):
        validate_assets(round_data('<img src="assets/round-001/../secret.png">'), assets, "assets/round-001/")


def test_video_sources_and_posters_share_image_asset_discovery():
    payload = round_data('<video src="assets/round-001/a.mp4" poster="assets/round-001/a&amp;b.png">'
                         '<source src="assets/round-001/b.webm" type="video/webm"></video>'
                         '<img src="assets/round-001/a&amp;b.png">')
    assert discover_references(payload) == [
        "assets/round-001/a.mp4", "assets/round-001/a&b.png", "assets/round-001/b.webm",
    ]


@pytest.mark.parametrize("html", [
    '<video src="assets/round-001/../outside.mp4"></video>',
    '<video poster="assets/round-001/../outside.png"></video>',
    '<video><source src="assets/round-001/../outside.webm"></video>',
])
def test_video_assets_cannot_escape_the_round_directory(tmp_path, html):
    with pytest.raises(RoundError):
        validate_assets(round_data(html), tmp_path, "assets/round-001/")


def test_video_manifest_rejects_mismatched_content_and_oversized_files(tmp_path):
    clip = tmp_path / "demo.mp4"
    clip.write_bytes(b"\x89PNG\r\n\x1a\n")
    payload = round_data('<video src="assets/round-001/demo.mp4"></video>')
    with pytest.raises(RoundError, match="media type mismatch"):
        validate_assets(payload, tmp_path, "assets/round-001/")
    with clip.open("wb") as file:
        file.write(b"\x00\x00\x00\x20ftypisom\x00\x00\x00\x00")
        file.truncate(grill_me_in_cloud_hook.MAX_VIDEO_BYTES + 1)
    with pytest.raises(RoundError, match="20 MiB"):
        validate_assets(payload, tmp_path, "assets/round-001/")


@pytest.fixture(params=["mp4", "webm"])
def video_clip(request, tmp_path):
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("Video integration checks require installed ffmpeg and ffprobe")
    clip = tmp_path / f"recording.{request.param}"
    codecs = ["-c:v", "libx264", "-c:a", "aac"] if request.param == "mp4" else ["-c:v", "libvpx-vp9", "-c:a", "libopus"]
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=5:d=0.4",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=0.4",
        *codecs, str(clip),
    ], check=True, capture_output=True, timeout=15)
    return clip


@pytest.mark.parametrize("provider", ["claude", "chatgpt", "pi"])
def test_videos_publish_and_retry_like_images_with_real_ffmpeg(tmp_path, video_clip, provider, monkeypatch):
    project = tmp_path / "project"
    project.mkdir()
    client = HostedBoard(fail=True)
    runtime = InterviewRuntime(tmp_path / "runtime", client)
    interview = runtime.start(provider, "session", project)
    original = video_clip.read_bytes()
    shutil.copyfile(video_clip, interview.assets / video_clip.name)
    poster = interview.assets / "poster.png"
    poster.write_bytes(b"\x89PNG\r\n\x1a\n")
    interview.source.write_text(json.dumps(round_data(
        f'<video poster="{interview.assets_url}poster.png"><source src="{interview.assets_url}{video_clip.name}" '
        f'type="video/{video_clip.suffix[1:]}"></video>'
    )), encoding="utf-8")
    with pytest.raises(HostedError):
        runtime.publish(provider, "session")
    assert (interview.assets / video_clip.name).read_bytes() == original
    staged_path = next((runtime.root / "outbox").rglob("publication.json"))
    staged = json.loads(staged_path.read_text(encoding="utf-8"))
    video_asset = next(asset for asset in staged["assets"] if asset["media_type"].startswith("video/"))
    prepared = staged_path.parent / video_asset["file"]
    assert video_asset["byte_size"] == prepared.stat().st_size
    assert video_asset["sha256"] == hashlib.sha256(prepared.read_bytes()).hexdigest()
    probe = subprocess.run([
        "ffprobe", "-v", "error", "-show_entries", "stream=codec_name,pix_fmt", "-of", "json", str(prepared),
    ], check=True, capture_output=True, timeout=10)
    streams = json.loads(probe.stdout)["streams"]
    assert [stream["codec_name"] for stream in streams] == (["h264", "aac"] if video_clip.suffix == ".mp4" else ["vp9", "opus"])
    assert streams[0]["pix_fmt"] == "yuv420p"
    if video_clip.suffix == ".mp4":
        content = prepared.read_bytes()
        assert content.index(b"moov") < content.index(b"mdat")
    # Retries upload the immutable prepared bytes without requiring FFmpeg again.
    monkeypatch.setattr(grill_me_in_cloud_hook.shutil, "which", lambda _: None)
    client.fail = False
    assert runtime.retry_pending(provider, "session")[0]["round_number"] == 1
    assert len(client.uploads) == 2
    video_upload = next(upload for upload in client.uploads if upload[2].startswith("video/"))
    assert video_upload[2] == video_asset["media_type"]
    assert hashlib.sha256(video_upload[1]).hexdigest() == video_asset["sha256"]
    assert not list((runtime.root / "outbox").rglob("publication.json"))


def test_missing_ffmpeg_rejects_only_videos_and_cleans_partial_publication(tmp_path, monkeypatch):
    project = tmp_path / "project"
    project.mkdir()
    runtime = InterviewRuntime(tmp_path / "runtime", HostedBoard())
    interview = runtime.start("claude", "session", project)
    (interview.assets / "demo.mp4").write_bytes(b"\x00\x00\x00\x20ftypisom\x00\x00\x00\x00")
    interview.source.write_text(json.dumps(round_data(f'<video src="{interview.assets_url}demo.mp4"></video>')), encoding="utf-8")
    monkeypatch.setattr(grill_me_in_cloud_hook.shutil, "which", lambda _: None)
    with pytest.raises(RoundError, match="ffmpeg on PATH"):
        runtime.publish("claude", "session")
    assert list((runtime.root / "outbox" / runtime.key("claude", "session")).iterdir()) == []
    interview = runtime.current("claude", "session")
    (interview.assets / "diagram.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    interview.source.write_text(json.dumps(round_data(f'<img src="{interview.assets_url}diagram.png">')), encoding="utf-8")
    assert runtime.publish("claude", "session")["round_number"] == 1


def test_ffmpeg_rejects_a_corrupt_video_before_it_can_be_queued(tmp_path):
    if not shutil.which("ffmpeg"):
        pytest.skip("Requires installed FFmpeg")
    project = tmp_path / "project"
    project.mkdir()
    runtime = InterviewRuntime(tmp_path / "runtime", HostedBoard())
    interview = runtime.start("claude", "session", project)
    (interview.assets / "corrupt.mp4").write_bytes(b"\x00\x00\x00\x20ftypisom\x00\x00\x00\x00")
    interview.source.write_text(json.dumps(round_data(f'<video src="{interview.assets_url}corrupt.mp4"></video>')), encoding="utf-8")
    with pytest.raises(RoundError, match="FFmpeg could not prepare"):
        runtime.publish("claude", "session")
    assert runtime.client.requests == []
    assert list((runtime.root / "outbox" / runtime.key("claude", "session")).iterdir()) == []


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


@pytest.mark.parametrize(("status", "body"), [
    (409, b"Conflict"),
    (400, b'{"statusCode":"409","error":"Duplicate","message":"The resource already exists"}'),
    (400, b'{"code":"KeyAlreadyExists"}'),
    (400, b'{"code":"ResourceAlreadyExists"}'),
    (400, b'{"error":"Duplicate"}'),
])
def test_signed_upload_accepts_only_known_duplicate_responses(tmp_path, monkeypatch, status, body):
    image = tmp_path / "diagram.png"
    image.write_bytes(b"\x89PNG\r\n\x1a\n")

    def fail(request, timeout):
        raise grill_me_in_cloud_hook.urllib.error.HTTPError(request.full_url, status, "Rejected", {}, io.BytesIO(body))

    monkeypatch.setattr(grill_me_in_cloud_hook.urllib.request, "urlopen", fail)
    HostedClient("https://grill.test", "1234").upload({"signed_url": "https://uploads.test/x"}, image, "image/png")


@pytest.mark.parametrize(("status", "body", "reason"), [
    (400, b'{"code":"InvalidMimeType"}', "InvalidMimeType"),
    (400, b'{"statusCode":"400","error":"InvalidRequest"}', "InvalidRequest"),
    (400, b"Bad request", ""),
    (400, b"[]", ""),
    (400, b'{"code":[]}', ""),
    (400, b'{"code":"https://uploads.test/x?token=secret"}', ""),
    (401, b'{"statusCode":"409","error":"Duplicate"}', "Duplicate"),
    (500, b'{"code":"InternalError"}', "InternalError"),
])
def test_upload_rejections_identify_asset_and_storage_code_without_signed_urls(tmp_path, monkeypatch, status, body, reason):
    image = tmp_path / "asset-000.png"
    image.write_bytes(b"\x89PNG\r\n\x1a\n")

    def fail(request, timeout):
        raise grill_me_in_cloud_hook.urllib.error.HTTPError(request.full_url, status, "Rejected", {}, io.BytesIO(body))

    monkeypatch.setattr(grill_me_in_cloud_hook.urllib.request, "urlopen", fail)
    with pytest.raises(HostedError) as raised:
        HostedClient("https://grill.test", "1234").upload(
            {"signed_url": "https://uploads.test/x?token=secret", "reference": "assets/round-001/diagram.png"},
            image, "image/png",
        )
    assert raised.value.status == status
    assert raised.value.code == "upload_failed"
    assert str(raised.value) == f"Asset upload failed ({status}) for assets/round-001/diagram.png" + (f" [{reason}]" if reason else "")


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


@pytest.mark.parametrize("provider,invocation", [("claude", "/grill-me-in-cloud"), ("chatgpt", "$grill-me-in-cloud")])
def test_followup_prompts_add_no_context_until_a_result_or_location_change(tmp_path, provider, invocation):
    project = tmp_path / "project"
    project.mkdir()
    client = HostedBoard()
    runtime = InterviewRuntime(tmp_path / "runtime", client)
    start = hook_event(project, "UserPromptSubmit", prompt=invocation)
    assert grill_me_in_cloud_hook.handle(start, provider, runtime) is not None
    interview = runtime.current(provider, "session")
    assert interview.assets.is_dir()

    followup = hook_event(project, "UserPromptSubmit", prompt="continue")
    assert grill_me_in_cloud_hook.handle(followup, provider, runtime) is None
    assert runtime.current(provider, "session").source == interview.source
    assert client.requests == []
    loaded = hook_event(project, "PostToolUse", tool_name="Skill", tool_input={"skill": "grill-me-in-cloud"})
    assert grill_me_in_cloud_hook.handle(loaded, provider, runtime) is None

    interview.source.write_text(json.dumps(round_data()), encoding="utf-8")
    result = grill_me_in_cloud_hook.handle(hook_event(project, "PostToolUse", tool_name="Write"), provider, runtime)
    assert result is not None
    assert runtime.current(provider, "session").source != interview.source
    assert grill_me_in_cloud_hook.handle(followup, provider, runtime) is None


def test_pi_followup_preparation_is_silent_and_publication_reports_question_count(tmp_path, monkeypatch):
    import grill_cloud_pi

    class PiBoard(HostedBoard):
        origin = "https://grill.test"
        code = "1234"

        def request(self, method, path, body=None, idempotency_key=None):
            if path == "/api/v1/capabilities":
                return {"providers": ["pi"], "pi_relay": 1}
            result = super().request(method, path, body, idempotency_key)
            if path.endswith("/commit"):
                result["round_id"] = "round-id"
            return result

        def session(self, provider, session_id):
            return {"session": {"provider_session_id": session_id}, "rounds": [{"id": "round-id", "status": "active"}]}

    project = tmp_path / "project"
    project.mkdir()
    runtime = grill_cloud_pi.PiInterviewRuntime(tmp_path / "runtime", PiBoard())
    monkeypatch.setattr(grill_cloud_pi.PiInterviewRuntime, "from_environment", lambda **kwargs: runtime)
    request = {"version": 1, "operation": "prepare", "cwd": str(project), "sessionId": "session",
               "sessionFile": str(tmp_path / "session.jsonl"), "anchor": "entry", "branchIds": ["entry"]}
    initial = grill_cloud_pi.handle(request | {"initial": True})
    assert initial["ok"]
    assert Path(initial["source"]).parent.is_dir()
    followup = grill_cloud_pi.handle(request)
    assert followup["ok"] and not followup["message"]
    assert followup["source"] == initial["source"]

    Path(initial["source"]).write_text(json.dumps(round_data()), encoding="utf-8")
    published = grill_cloud_pi.handle(request | {"operation": "publish"})
    assert published["ok"]
    assert published["published"]["question_count"] == 1
    assert published["source"] != initial["source"]
    followup = grill_cloud_pi.handle(request | {"confirmedRoundIds": ["round-id"]})
    assert followup["ok"] and not followup["message"]


def test_pi_retry_confirmation_survives_consumed_outbox_and_process_restart(tmp_path, monkeypatch):
    import grill_cloud_pi

    class PiBoard(HostedBoard):
        origin = "https://grill.test"
        code = "1234"
        status = "active"

        def request(self, method, path, body=None, idempotency_key=None):
            if path == "/api/v1/capabilities":
                return {"providers": ["pi"], "pi_relay": 1}
            result = super().request(method, path, body, idempotency_key)
            if path.endswith("/commit"):
                result["round_id"] = "recovered-round"
            return result

        def session(self, provider, session_id):
            return {"session": {"provider_session_id": session_id}, "rounds": [{"id": "recovered-round", "status": self.status}]}

    project = tmp_path / "project"
    project.mkdir()
    board = PiBoard()
    root = tmp_path / "runtime"
    monkeypatch.setattr(grill_cloud_pi.PiInterviewRuntime, "from_environment", lambda **kwargs: grill_cloud_pi.PiInterviewRuntime(root, board))
    request = {"version": 1, "operation": "prepare", "cwd": str(project), "sessionId": "session",
               "sessionFile": str(tmp_path / "session.jsonl"), "anchor": "publication-tool", "branchIds": ["start", "publication-tool"]}
    initial = grill_cloud_pi.handle(request)
    Path(initial["source"]).write_text(json.dumps(round_data()), encoding="utf-8")
    board.fail = True
    assert not grill_cloud_pi.handle(request | {"operation": "publish"})["ok"]
    board.fail = False
    retried = grill_cloud_pi.handle(request)
    assert retried["published"]["round_id"] == "recovered-round"
    assert not list((root / "outbox").rglob("publication.json"))
    mutations = len(board.requests)

    # The confirmation receipt was left on another leaf, but its originating tool is still an ancestor.
    navigated = request | {"anchor": "new-leaf", "branchIds": ["start", "publication-tool", "new-leaf"]}
    recovered = grill_cloud_pi.handle(navigated)
    assert recovered["published"] == retried["published"]
    assert len(board.requests) == mutations
    confirmed = grill_cloud_pi.handle(navigated | {"confirmedRoundIds": ["recovered-round"]})
    assert confirmed["published"] == retried["published"]
    assert not confirmed["message"]

    # Neither unrelated branches, files, native sessions, nor boards may inherit the receipt.
    for change in [{"branchIds": ["new-leaf"]}, {"sessionFile": "other.jsonl"}, {"sessionId": "fork"}]:
        assert grill_cloud_pi.handle(navigated | change)["published"] is None
    board.origin = "https://other.test"
    assert grill_cloud_pi.handle(navigated)["published"] is None
    board.origin = "https://grill.test"
    board.status = "superseded"
    assert grill_cloud_pi.handle(navigated)["published"] is None


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


def test_failed_video_preparation_preserves_an_older_queued_round(tmp_path, monkeypatch):
    project = tmp_path / "project"
    project.mkdir()
    runtime = InterviewRuntime(tmp_path / "runtime", HostedBoard(fail=True))
    interview = runtime.start("claude", "session", project)
    interview.source.write_text(json.dumps(round_data()), encoding="utf-8")
    with pytest.raises(HostedError):
        runtime.publish("claude", "session")
    older = next((runtime.root / "outbox").rglob("publication.json"))
    interview = runtime.current("claude", "session")
    (interview.assets / "demo.mp4").write_bytes(b"\x00\x00\x00\x20ftypisom\x00\x00\x00\x00")
    interview.source.write_text(json.dumps(round_data(f'<video src="{interview.assets_url}demo.mp4"></video>')), encoding="utf-8")
    monkeypatch.setattr(grill_me_in_cloud_hook.shutil, "which", lambda _: None)
    with pytest.raises(RoundError):
        runtime.publish("claude", "session")
    assert list((runtime.root / "outbox").rglob("publication.json")) == [older]
    runtime.client.fail = False
    assert runtime.retry_pending("claude", "session")[0]["round_number"] == 1


@pytest.mark.parametrize("text", ["caf\u00e9 \u65e5\u672c\u8a9e \U0001f600", "lone \ud800 surrogate"])
def test_hosted_client_preserves_unicode_json_values(monkeypatch, text):
    requests = []
    def urlopen(request, timeout):
        requests.append(json.loads(request.data.decode("utf-8")))
        return io.BytesIO(b'{"ok":true}')
    monkeypatch.setattr(grill_me_in_cloud_hook.urllib.request, "urlopen", urlopen)
    assert HostedClient("https://grill.test", "1234").request("POST", "/rounds", {"title": text}) == {"ok": True}
    assert requests == [{"title": text}]


@pytest.mark.parametrize("provider", ["claude", "pi"])
@pytest.mark.parametrize("text", ["caf\u00e9 \u65e5\u672c\u8a9e \U0001f600", "lone \ud800 surrogate"])
def test_staging_preserves_unicode_json_values(tmp_path, provider, text):
    if provider == "pi":
        from grill_cloud_pi import PiInterviewRuntime
        runtime = PiInterviewRuntime(tmp_path / "runtime", HostedBoard())
        runtime.bind({"sessionFile": "session.jsonl", "anchor": "entry", "branchIds": ["entry"]})
    else:
        runtime = InterviewRuntime(tmp_path / "runtime", HostedBoard())
    payload = round_data()
    payload["questions"][0]["question"] = text
    publication = runtime._stage(provider, "session", payload, [], text, None)
    staged = json.loads(publication.read_text(encoding="utf-8"))
    assert staged["title"] == text
    assert staged["payload"] == payload
    if provider == "pi":
        assert staged["pi_session_file"] == "session.jsonl"
        assert staged["pi_anchor"] == "entry"
