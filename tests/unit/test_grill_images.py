import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import struct
import sys
import threading
import uuid
import zlib

import pytest

sys.path.insert(0, str(Path(__file__).parents[2] / "harness/planning/grill-me-in-cloud"))
from grill_images import ImageError, download_snapshot, valid_png
from grill_me_in_cloud_hook import HostedClient


def png():
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00\xff")) + chunk(b"IEND", b"")


@pytest.fixture
def board():
    content = png()
    snapshot_id, asset_id = str(uuid.uuid4()), str(uuid.uuid4())
    state = {"bytes": content, "requests": [], "redirect": False, "snapshot": {
        "id": snapshot_id, "images": [{"asset_id": asset_id, "question_id": "Q1", "diagram_id": "flow", "media_type": "image/png", "byte_size": len(content), "sha256": hashlib.sha256(content).hexdigest()}],
    }}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            state["requests"].append(self.path)
            if self.headers.get("Authorization") != "Bearer 1234":
                self.send_response(401)
                self.end_headers()
                return
            if state["redirect"]:
                self.send_response(302)
                self.send_header("Location", "http://127.0.0.1:1/credentials-must-not-arrive")
                self.end_headers()
                return
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps({"snapshot": state["snapshot"]}).encode() if "/prompt-snapshots/" in self.path else state["bytes"])

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    state.update(origin=f"http://127.0.0.1:{server.server_port}", snapshot_id=snapshot_id)
    yield state
    server.shutdown()
    server.server_close()
    thread.join()


def test_authenticated_snapshot_cache_retry_and_corruption(board, tmp_path):
    client = HostedClient(board["origin"], "1234")
    images = download_snapshot(client, board["snapshot_id"], tmp_path)
    assert images == [{"question_id": "Q1", "diagram_id": "flow", "path": str(tmp_path / (hashlib.sha256(png()).hexdigest() + ".png"))}]
    destination = Path(images[0]["path"])
    assert destination.is_absolute() and destination.read_bytes() == png()
    download_snapshot(client, board["snapshot_id"], tmp_path)
    assert len(board["requests"]) == 3  # second request verifies snapshot, reuses immutable bytes
    destination.write_bytes(b"corrupt")
    download_snapshot(client, board["snapshot_id"], tmp_path)
    assert destination.read_bytes() == png()
    assert len(board["requests"]) == 5


def test_auth_failure_redirect_checksum_and_metadata_are_safe(board, tmp_path):
    with pytest.raises(ImageError):
        download_snapshot(HostedClient(board["origin"], "9876"), board["snapshot_id"], tmp_path)
    board["redirect"] = True
    with pytest.raises(ImageError):
        download_snapshot(HostedClient(board["origin"], "1234"), board["snapshot_id"], tmp_path)
    board["redirect"] = False
    board["bytes"] = b"x" * len(png())
    with pytest.raises(ImageError):
        download_snapshot(HostedClient(board["origin"], "1234"), board["snapshot_id"], tmp_path)
    board["snapshot"]["images"][0]["asset_id"] = "../../foreign"
    before = len(board["requests"])
    with pytest.raises(ImageError):
        download_snapshot(HostedClient(board["origin"], "1234"), board["snapshot_id"], tmp_path)
    assert len(board["requests"]) == before + 1
    assert not list(tmp_path.iterdir())


def test_png_validation_rejects_corruption_and_trailing_data():
    assert valid_png(png())
    assert not valid_png(png() + b"unexpected")
    assert not valid_png(png()[:-1])


def test_one_invocation_returns_all_question_diagram_identities(board, tmp_path):
    second = board["snapshot"]["images"][0] | {"asset_id": str(uuid.uuid4()), "question_id": "Q2", "diagram_id": "flow"}
    board["snapshot"]["images"].append(second)
    images = download_snapshot(HostedClient(board["origin"], "1234"), board["snapshot_id"], tmp_path)
    assert [(item["question_id"], item["diagram_id"]) for item in images] == [("Q1", "flow"), ("Q2", "flow")]
    assert images[0]["path"] == images[1]["path"]
    assert len(board["requests"]) == 2


def test_helper_errors_are_nonzero_without_credentials(board, tmp_path):
    import os
    import subprocess
    environment = dict(os.environ, HARNESS_GRILL_URL=board["origin"], HARNESS_GRILL_CODE="9876", HARNESS_STATE_DIR=str(tmp_path / "external state"))
    run = subprocess.run([sys.executable, str(Path(__file__).parents[2] / "harness/planning/grill-me-in-cloud/grill_images.py"), board["snapshot_id"]], cwd=tmp_path, env=environment, capture_output=True, text=True, timeout=10)
    assert run.returncode == 1
    assert not run.stdout
    assert "9876" not in run.stderr
