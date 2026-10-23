import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import threading

import pytest


SCRIPT = Path(__file__).parents[2] / "harness/planning/grill-me-in-cloud/scripts/download_grill_image.py"
IMAGE_ID = "22222222-2222-4222-8222-222222222222"
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==")


@pytest.fixture
def board():
    state = {"requests": [], "body": PNG, "etag": hashlib.sha256(PNG).hexdigest(), "status": 200}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            state["requests"].append((self.path, self.headers.get("Authorization")))
            status = state["status"] if self.headers.get("Authorization") == "Bearer 8976" else 401
            self.send_response(status)
            self.send_header("Content-Type", "image/png")
            self.send_header("ETag", f'"{state["etag"]}"')
            self.send_header("Location", "/foreign")
            self.end_headers()
            self.wfile.write(state["body"])

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    state["url"] = f"http://127.0.0.1:{server.server_port}"
    yield state
    server.shutdown()
    server.server_close()
    thread.join()


def config(path, **fields):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"version": 1, "grill": fields}), encoding="utf-8")


def run_download(tmp_path, board, source="project", image_id=IMAGE_ID):
    project = tmp_path / "project"
    project.mkdir(exist_ok=True)
    state = tmp_path / "state"
    home = tmp_path / "home"
    env = {key: value for key, value in os.environ.items() if key not in {"HARNESS_GRILL_URL", "HARNESS_GRILL_CODE"}}
    env.update(HARNESS_STATE_DIR=str(state), USERPROFILE=str(home), HOME=str(home))
    # A committed project config supplies the URL, never the credential.
    config(project / ".harness/config.json", url=board["url"], code="0000")
    if source == "project":
        config(project / ".harness/config.local.json", code="8976")
        config(state / "config.json", code="0000", url="http://127.0.0.1:1")
        env["HARNESS_GRILL_CODE"] = "0000"
    elif source == "user":
        config(state / "config.json", code="8976")
        env["HARNESS_GRILL_CODE"] = "0000"
    elif source == "home":
        env.pop("HARNESS_STATE_DIR")
        env["LOCALAPPDATA"] = str(tmp_path / "local")
        env["XDG_STATE_HOME"] = str(tmp_path / "xdg")
        config(home / ".harness/config.json", code="8976")
    elif source == "environment":
        env["HARNESS_GRILL_CODE"] = "8976"
    return subprocess.run(
        [sys.executable, str(SCRIPT), image_id], cwd=project, env=env,
        capture_output=True, text=True, timeout=10,
    )


@pytest.mark.parametrize("source", ["project", "user", "home", "environment"])
def test_cli_resolves_credentials_and_saves_reviewed_image_near_inboxes(tmp_path, board, source):
    result = run_download(tmp_path, board, source)
    assert result.returncode == 0, result.stderr
    if source == "home":
        root = tmp_path / "local/harness/grill" if os.name == "nt" else tmp_path / "xdg/harness/grill"
    else:
        root = tmp_path / "state/grill"
    destination = root / "images" / f"{IMAGE_ID}.png"
    assert destination.read_bytes() == PNG
    assert str(destination.resolve()) in result.stdout
    assert "8976" not in result.stdout + result.stderr
    assert board["requests"] == [(f"/api/v1/assets/{IMAGE_ID}", "Bearer 8976")]


@pytest.mark.parametrize("failure", ["unauthorized", "redirect", "corrupt", "oversized"])
def test_failed_download_returns_error_without_credentials_or_partial_image(tmp_path, board, failure):
    if failure == "unauthorized":
        board["status"] = 401
    elif failure == "redirect":
        board["status"] = 307
    elif failure == "corrupt":
        board["body"] = PNG + b"corrupt"
    else:
        board["body"] = b"x" * (6 * 1024 * 1024 + 1)
    result = run_download(tmp_path, board)
    assert result.returncode != 0
    assert result.stderr
    assert "8976" not in result.stdout + result.stderr
    assert not list((tmp_path / "state").rglob("*.png"))
    assert len(board["requests"]) == 1


def test_invalid_id_and_missing_code_make_no_requests(tmp_path, board):
    assert run_download(tmp_path, board, image_id="../../foreign").returncode != 0
    assert board["requests"] == []
    (tmp_path / "project/.harness/config.local.json").unlink()
    (tmp_path / "state/config.json").unlink()
    assert run_download(tmp_path, board, source="missing").returncode != 0
    assert board["requests"] == []
