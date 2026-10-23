"""Download one reviewed Grill image by its immutable asset ID."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid

MAX_IMAGE_BYTES = 6 * 1024 * 1024
DEFAULT_URL = "https://grill-me-in-cloud.vercel.app"


class DownloadError(ValueError):
    pass


def grill_section(path: Path) -> dict:
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        section = data.get("grill", {})
        if data.get("version") != 1 or not isinstance(section, dict):
            raise ValueError()
        return section
    except (OSError, ValueError, AttributeError):
        raise DownloadError("Invalid Harness configuration. Check the grill settings.") from None


def target(project: Path) -> tuple[str, str]:
    # Match HostedClient.from_environment: resolve each field independently.
    user_root = Path(os.environ.get("HARNESS_STATE_DIR") or Path.home() / ".harness").expanduser()
    local = grill_section(project / ".harness/config.local.json")
    shared = grill_section(project / ".harness/config.json")
    user = grill_section(user_root / "config.json")
    origin = local.get("url") or shared.get("url") or user.get("url") or os.environ.get("HARNESS_GRILL_URL") or DEFAULT_URL
    code = local.get("code") or user.get("code") or os.environ.get("HARNESS_GRILL_CODE", "")
    if not isinstance(code, str) or not re.fullmatch(r"\d{4}", code, flags=re.ASCII):
        raise DownloadError("Configure a four-digit grill.code in Harness configuration.")
    if not isinstance(origin, str):
        raise DownloadError("Configure grill.url as an HTTP(S) origin.")
    parsed = urllib.parse.urlsplit(origin)
    if (parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.path
            or parsed.query or parsed.fragment or parsed.username or parsed.password):
        raise DownloadError("Configure grill.url as an HTTP(S) origin without a trailing slash.")
    return origin, code


def image_directory() -> Path:
    # Keep downloaded feedback beside the runtime's inboxes, outside skill files.
    override = os.environ.get("HARNESS_STATE_DIR")
    if override:
        root = Path(override).expanduser() / "grill"
    elif os.name == "nt" and os.environ.get("LOCALAPPDATA"):
        root = Path(os.environ["LOCALAPPDATA"]) / "harness/grill"
    else:
        root = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state")) / "harness/grill"
    return (root / "images").resolve()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise DownloadError("The board redirected the image request. Check grill.url.")


def download(image_id: str) -> Path:
    try:
        image_id = str(uuid.UUID(image_id))
    except ValueError:
        raise DownloadError("Image ID must be a UUID.") from None
    origin, code = target(Path.cwd())
    request = urllib.request.Request(
        f"{origin}/api/v1/assets/{image_id}", headers={"Authorization": f"Bearer {code}"},
    )
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=20) as response:
            data = response.read(MAX_IMAGE_BYTES + 1)
            digest = response.headers.get("ETag", "").strip('"')
            media_type = response.headers.get_content_type()
    except urllib.error.HTTPError as error:
        raise DownloadError(f"Image download failed (HTTP {error.code}). Check the image ID and Grill configuration.") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise DownloadError("Image download failed. Check board availability and retry the same ID.") from None
    if len(data) > MAX_IMAGE_BYTES:
        raise DownloadError("Image exceeds the 6 MiB download limit.")
    if media_type != "image/png" or not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise DownloadError("The board did not return a PNG image.")
    if not re.fullmatch(r"[a-f0-9]{64}", digest) or hashlib.sha256(data).hexdigest() != digest:
        raise DownloadError("Image checksum verification failed. Retry the same ID.")
    directory = image_directory()
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / f"{image_id}.png"
    descriptor, name = tempfile.mkstemp(dir=directory, prefix=".download-", suffix=".tmp")
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
        os.replace(name, destination)
    finally:
        Path(name).unlink(missing_ok=True)
    return destination


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image_id", help="Image ID from reviewed Grill answers")
    args = parser.parse_args()
    try:
        path = download(args.image_id)
    except DownloadError as error:
        print(f"Error. {error}", file=sys.stderr)
        return 1
    except Exception:
        print("Error. Image download failed. Check Harness configuration and local storage.", file=sys.stderr)
        return 1
    print(f"Success. Image downloaded at `{path}`.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
