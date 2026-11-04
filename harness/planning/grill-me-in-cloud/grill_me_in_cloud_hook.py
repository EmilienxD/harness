"""Hosted Grill board runtime and provider hook."""
from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET
from contextlib import contextmanager
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path

DEFAULT_GRILL_URL = "https://grill-me-in-cloud.vercel.app"
SCHEMA_VERSION = 1
MAX_IMAGE_BYTES = 6 * 1024 * 1024
MAX_VIDEO_BYTES = 20 * 1024 * 1024
MAX_ROUND_BYTES = 50 * 1024 * 1024
MAX_ASSETS = 30
# Lowercase letters and digits without the look-alikes 0/o and 1/i/l.
INBOX_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"
MEDIA_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif",
    ".svg": "image/svg+xml",
    ".mp4": "video/mp4", ".webm": "video/webm",
}


class RoundError(ValueError):
    """The authored round or one of its local assets is invalid."""


class HostedError(RuntimeError):
    def __init__(self, message: str, code: str = "hosted_error", status: int | None = None):
        super().__init__(message)
        self.code = code
        self.status = status

    @property
    def retryable(self) -> bool:
        """Outages and uploads can heal on retry, since a retry re-signs upload targets; other rejections cannot."""
        if self.code == "missing_configuration":
            return False
        if self.status is None or self.code == "upload_failed":
            return True
        return self.status >= 500 or self.status in {408, 429}


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(dir=path.parent, prefix=".grill-", suffix=".tmp")
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as file:
            file.write(content)
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def project_identity(project: Path, home: Path | None = None) -> dict[str, str]:
    """Return stable display metadata without publishing the user's home directory."""
    resolved = project.expanduser().resolve()
    resolved_home = (home or Path.home()).expanduser().resolve()
    try:
        relative = resolved.relative_to(resolved_home)
        display_path = "~" if not relative.parts else str(Path("~") / relative)
    except ValueError:
        display_path = str(resolved)
    return {"name": resolved.name or resolved.anchor, "path": display_path}


def user_config_path() -> Path:
    override = os.environ.get("HARNESS_STATE_DIR")
    return (Path(override).expanduser() if override else Path.home() / ".harness") / "config.json"


def grill_section(path: Path) -> dict:
    """Return the `grill` section of a Harness config file, empty when the file is absent."""
    if not path.is_file():
        return {}
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f"Invalid Harness config at {path}: {error}") from error
    if not isinstance(config, dict) or config.get("version") != 1:
        raise ValueError(f"Harness config at {path} must be a version-1 JSON object")
    section = config.get("grill", {})
    if not isinstance(section, dict):
        raise ValueError(f"Harness config at {path}: grill must be an object")
    return section


def validate_round(data: object) -> dict:
    if not isinstance(data, dict):
        raise RoundError("Round must be a JSON object")
    questions = data.get("questions")
    if not isinstance(questions, list) or not questions:
        raise RoundError("questions must be a nonempty array")
    ids: set[str] = set()
    for question in questions:
        if not isinstance(question, dict):
            raise RoundError("Each question must be an object")
        qid = question.get("id")
        if not isinstance(qid, str) or not re.fullmatch(r"Q[1-9][0-9]*", qid) or qid in ids:
            raise RoundError("Question IDs must be unique Q1, Q2, etc. identifiers")
        ids.add(qid)
        for field in ("question", "explanation_html"):
            if not isinstance(question.get(field), str) or not question[field].strip():
                raise RoundError(f"{qid}: {field} must be nonempty text")
        discover_diagrams(question["explanation_html"])
        if "init_js" in question and not isinstance(question["init_js"], str):
            raise RoundError(f"{qid}: init_js must be text")
        options = question.get("options")
        if not isinstance(options, list) or not 1 <= len(options) <= 4:
            raise RoundError(f"{qid}: provide 1-4 options")
        letters = "ABCD"[:len(options)]
        for letter, option in zip(letters, options):
            if not isinstance(option, dict) or option.get("letter") != letter:
                raise RoundError(f"{qid}: options must be labeled consecutively A-D")
            for field in ("label", "detail"):
                if not isinstance(option.get(field), str) or not option[field].strip():
                    raise RoundError(f"{qid} {letter}: {field} is required")
        if question.get("recommendation") not in letters:
            raise RoundError(f"{qid}: recommendation must name an available option")
    return data


class _DiagramParser(HTMLParser):
    """Read only explicit diagram figures; unrelated explanation HTML stays untouched."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.diagrams: list[dict[str, str]] = []
        self.ids: set[str] = set()
        self.stack: list[str] = []
        self.diagram: dict[str, str] | None = None
        self.sources = 0
        self.captions = 0
        self.part: str | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if "data-grill-diagram" in values:
            identity = values["data-grill-diagram"] or ""
            if self.diagram is not None or tag != "figure" or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,63}", identity) or identity in self.ids:
                raise RoundError("Diagram figures need unique IDs starting with a letter (up to 64 letters, digits, _ or -)")
            self.ids.add(identity)
            self.diagram = {"id": identity, "source": "", "caption": ""}
            self.stack = []
            self.sources = self.captions = 0
            return
        if self.diagram is None:
            return
        if self.stack and self.stack[0] == "pre":
            raise RoundError("Diagram pre.mermaid must contain escaped source text")
        if not self.stack and tag == "pre" and "mermaid" in (values.get("class") or "").split():
            self.sources += 1
            self.part = "source"
        elif not self.stack and tag == "figcaption":
            self.captions += 1
            self.part = "caption"
        elif not self.stack:
            self.part = None
        if tag not in {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}:
            self.stack.append(tag)

    def handle_endtag(self, tag: str) -> None:
        if self.diagram is None:
            return
        if tag == "figure" and not self.stack:
            diagram = self.diagram
            if self.sources != 1 or self.captions != 1 or not diagram["source"].strip() or not diagram["caption"].strip():
                raise RoundError(f"Diagram {diagram['id']} needs one direct pre.mermaid containing escaped source text and one nonempty figcaption")
            self.diagrams.append({key: value.replace("\r\n", "\n").replace("\r", "\n").strip() for key, value in diagram.items()})
            self.diagram = None
        elif self.stack and self.stack[-1] == tag:
            self.stack.pop()

    def handle_data(self, data: str) -> None:
        if self.diagram is not None and self.stack and self.part:
            self.diagram[self.part] += data


def discover_diagrams(html: str) -> list[dict[str, str]]:
    parser = _DiagramParser()
    parser.feed(html)
    parser.close()
    if parser.diagram is not None:
        raise RoundError("Diagram figure must have a closing tag")
    return parser.diagrams


def _srcset_urls(value: str) -> list[str]:
    """Parse candidates without treating a data URL's comma as a separator."""
    urls: list[str] = []
    index = 0
    while index < len(value):
        while index < len(value) and (value[index].isspace() or value[index] == ","):
            index += 1
        if index >= len(value):
            break
        start = index
        is_data = value[index:index + 5].lower() == "data:"
        while index < len(value) and not value[index].isspace() and (is_data or value[index] != ","):
            index += 1
        urls.append(value[start:index])
        while index < len(value) and value[index] != ",":
            index += 1
        if index < len(value):
            index += 1
    return urls


class _MediaReferences(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.references: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {name.lower(): value for name, value in attrs if value is not None}
        lowered = tag.lower()
        if lowered in {"img", "video", "source"} and values.get("src"):
            self.references.append(values["src"])
        if lowered == "video" and values.get("poster"):
            self.references.append(values["poster"])
        if lowered in {"img", "source"} and values.get("srcset"):
            self.references.extend(_srcset_urls(values["srcset"]))
        # Interactive previews keep URLs in option values, links, or data-* attributes.
        # The reserved assets/ prefix declares these files even before an img displays them.
        self.references.extend(value for name, value in values.items()
                               if name != "srcset" and value.startswith("assets/"))


def discover_references(payload: dict) -> list[str]:
    references: list[str] = []
    seen: set[str] = set()
    for question in payload["questions"]:
        parser = _MediaReferences()
        parser.feed(question["explanation_html"])
        parser.close()
        for reference in parser.references:
            if reference not in seen:
                seen.add(reference)
                references.append(reference)
    return references


def _sniff_media(path: Path, declared: str) -> bool:
    with path.open("rb") as file:
        sample = file.read(4096)
    if declared == "video/mp4":
        return len(sample) >= 16 and sample[4:8] == b"ftyp" and sample[8:12] in {
            b"isom", b"iso2", b"iso3", b"iso4", b"iso5", b"iso6", b"iso8", b"iso9",
            b"mp41", b"mp42", b"avc1", b"M4V ", b"dash",
        }
    if declared == "video/webm":
        return sample.startswith(b"\x1a\x45\xdf\xa3") and b"webm" in sample
    if declared == "image/png":
        return sample.startswith(b"\x89PNG\r\n\x1a\n")
    if declared == "image/jpeg":
        return sample.startswith(b"\xff\xd8\xff")
    if declared == "image/gif":
        return sample.startswith((b"GIF87a", b"GIF89a"))
    if declared == "image/webp":
        return len(sample) >= 12 and sample[:4] == b"RIFF" and sample[8:12] == b"WEBP"
    if declared == "image/avif":
        return len(sample) >= 16 and sample[4:8] == b"ftyp" and sample[8:12] in {b"avif", b"avis"}
    if declared == "image/svg+xml":
        try:
            return ET.parse(path).getroot().tag.rsplit("}", 1)[-1].lower() == "svg"
        except (ET.ParseError, OSError):
            return False
    return False


def validate_assets(payload: dict, assets_dir: Path, assets_prefix: str) -> list[dict]:
    root = assets_dir.resolve()
    manifest: list[dict] = []
    total = 0
    for reference in discover_references(payload):
        parsed = urllib.parse.urlsplit(reference)
        if parsed.scheme.lower() in {"http", "https", "data"}:
            continue
        if parsed.scheme or parsed.netloc or not reference.startswith(assets_prefix):
            raise RoundError(f"Unsupported local asset reference: {reference}")
        relative = urllib.parse.unquote(parsed.path[len(assets_prefix):])
        if not relative or parsed.query or parsed.fragment or Path(relative).is_absolute():
            raise RoundError(f"Invalid local asset reference: {reference}")
        candidate = (root / Path(relative)).resolve(strict=False)
        if not candidate.is_relative_to(root) or not candidate.is_file():
            raise RoundError(f"Local asset is missing or escapes the round assets directory: {reference}")
        media_type = MEDIA_TYPES.get(candidate.suffix.lower()) or mimetypes.guess_type(candidate.name)[0]
        if media_type and media_type.startswith("video/") and candidate.suffix.lower() not in {".mp4", ".webm"}:
            raise RoundError(f"Video previews must use .mp4 or .webm: {reference}")
        if media_type not in MEDIA_TYPES.values() or not _sniff_media(candidate, media_type):
            raise RoundError(f"Unsupported asset or media type mismatch: {reference}")
        size = candidate.stat().st_size
        is_video = media_type.startswith("video/")
        limit = MAX_VIDEO_BYTES if is_video else MAX_IMAGE_BYTES
        if not size or size > limit:
            raise RoundError(f"{'Video' if is_video else 'Image'} must be nonempty and at most {limit // (1024 * 1024)} MiB: {reference}")
        total += size
        if total > MAX_ROUND_BYTES:
            raise RoundError("Round assets exceed 50 MiB")
        if len(manifest) >= MAX_ASSETS:
            raise RoundError(f"Round contains more than {MAX_ASSETS} local assets")
        with candidate.open("rb") as file:
            digest = hashlib.file_digest(file, "sha256").hexdigest()
        manifest.append({
            "reference": reference, "path": candidate, "media_type": media_type,
            "byte_size": size, "sha256": digest,
        })
    return manifest


def prepare_video(source: Path, destination: Path, deadline: float) -> None:
    """Prepare browser-ready previews locally; FFmpeg is supplied by the user, never installed here."""
    executable = shutil.which("ffmpeg")
    if not executable:
        raise RoundError("Video previews require ffmpeg on PATH. Make the installed FFmpeg available and republish the round.")
    codec = (
        ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-crf", "32", "-b:v", "0", "-c:a", "libopus"]
        if source.suffix.lower() == ".webm" else
        ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-movflags", "+faststart"]
    )
    command = [
        executable, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-protocol_whitelist", "file,pipe", "-i", str(source),
        "-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "-1", "-sn", "-dn",
        "-vf", "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
        "-fpsmax", "30", "-pix_fmt", "yuv420p", "-threads", "2", *codec, "-b:a", "128k", str(destination),
    ]
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.PIPE, timeout=max(0.1, deadline - time.monotonic()),
                                **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}))
    except subprocess.TimeoutExpired as error:
        raise RoundError("Video preparation exceeded 60 seconds. Shorten or compress the clips and republish.") from error
    except OSError as error:
        raise RoundError(f"Cannot run the installed FFmpeg: {error}") from error
    if result.returncode:
        raise RoundError(f"FFmpeg could not prepare {source.name}. Check that the file is a playable video and FFmpeg supports its codecs.")
    if not destination.is_file() or not 0 < destination.stat().st_size <= MAX_VIDEO_BYTES:
        raise RoundError(f"Prepared video must be nonempty and at most 20 MiB: {source.name}. Shorten or compress it and republish.")


@dataclass
class Interview:
    directory: Path
    sequence: int = 1

    @property
    def source(self) -> Path:
        return self.directory / f"round-{self.sequence:03d}.json"

    @property
    def assets(self) -> Path:
        return self.directory / "assets" / f"round-{self.sequence:03d}"

    @property
    def assets_url(self) -> str:
        return f"assets/round-{self.sequence:03d}/"


class HostedClient:
    def __init__(self, origin: str, code: str, timeout: float = 15.0):
        if not re.fullmatch(r"\d{4}", code):
            raise ValueError("The grill code must contain exactly four ASCII digits")
        parsed = urllib.parse.urlsplit(origin)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.netloc
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
            or parsed.username
            or parsed.password
            or origin.endswith("/")
        ):
            raise ValueError("The grill URL must be an HTTP(S) origin without a path")
        self.origin = origin
        self.code = code
        self.timeout = timeout

    @classmethod
    def from_environment(cls, project: Path | None = None) -> "HostedClient":
        """Resolve each field from its first configured source; the committed project config never supplies the code."""
        local = grill_section(project / ".harness" / "config.local.json") if project else {}
        shared = grill_section(project / ".harness" / "config.json") if project else {}
        user = grill_section(user_config_path())
        origin = local.get("url") or shared.get("url") or user.get("url") or os.environ.get("HARNESS_GRILL_URL") or DEFAULT_GRILL_URL
        code = local.get("code") or user.get("code") or os.environ.get("HARNESS_GRILL_CODE", "")
        if not code:
            raise ValueError(
                "grill.code is required in .harness/config.local.json or ~/.harness/config.json, "
                "or set HARNESS_GRILL_CODE. grill.url is an optional override of " + DEFAULT_GRILL_URL
            )
        if not isinstance(origin, str) or not isinstance(code, str):
            raise ValueError("Hosted grill URL and code must be strings")
        return cls(origin, code)

    def request(self, method: str, path: str, body: object | None = None, idempotency_key: str | None = None) -> dict:
        headers = {"Authorization": f"Bearer {self.code}", "Accept": "application/json"}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        request = urllib.request.Request(self.origin + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            try:
                payload = json.loads(error.read().decode("utf-8"))
                detail = payload.get("error", {})
                raise HostedError(detail.get("message") or str(error), detail.get("code", "http_error"), error.code) from error
            except (UnicodeError, json.JSONDecodeError, AttributeError):
                raise HostedError(str(error), "http_error", error.code) from error
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            raise HostedError(f"Hosted board is unavailable: {error}", "network_error") from error

    def upload(self, target: dict, path: Path, media_type: str) -> None:
        """Signed Storage uploads are PUT; a duplicate means the object is already durable."""
        request = urllib.request.Request(target["signed_url"], data=path.read_bytes(), method="PUT", headers={"Content-Type": media_type, "x-upsert": "false"})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                response.read()
        except urllib.error.HTTPError as error:
            try:
                detail = json.loads(error.read(4096).decode("utf-8"))
            except (UnicodeError, json.JSONDecodeError):
                detail = {}
            if not isinstance(detail, dict):
                detail = {}
            duplicate = error.code == 409 or (error.code == 400 and (
                str(detail.get("statusCode")) == "409" or detail.get("error") == "Duplicate" or
                detail.get("code") in ("KeyAlreadyExists", "ResourceAlreadyExists")
            ))
            if not duplicate:
                storage_code = detail.get("code") or detail.get("error")
                reason = f" [{storage_code}]" if isinstance(storage_code, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,79}", storage_code) else ""
                reference = target.get("reference", path.name)
                raise HostedError(f"Asset upload failed ({error.code}) for {reference}{reason}", "upload_failed", error.code) from error
        except (urllib.error.URLError, TimeoutError) as error:
            raise HostedError(f"Asset upload failed: {error}", "upload_failed") from error

    def session(self, provider: str, session_id: str) -> dict | None:
        path = f"/api/v1/sessions/{urllib.parse.quote(provider, safe='')}/{urllib.parse.quote(session_id, safe='')}"
        try:
            return self.request("GET", path)
        except HostedError as error:
            if error.status == 404:
                return None
            raise


class InterviewRuntime:
    def __init__(self, root: Path | None = None, client: HostedClient | None = None):
        self.root = (root or self.default_root()).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.client = client
        self.configuration_error: str | None = None

    @classmethod
    def from_environment(cls, root: Path | None = None, project: Path | None = None) -> "InterviewRuntime":
        """Stay usable without hosted configuration so unrelated sessions see no hook output."""
        try:
            return cls(root, HostedClient.from_environment(project))
        except ValueError as error:
            runtime = cls(root)
            runtime.configuration_error = str(error)
            return runtime

    @staticmethod
    def default_root() -> Path:
        override = os.environ.get("HARNESS_STATE_DIR")
        if override:
            return Path(override).expanduser() / "grill"
        if os.name == "nt" and os.environ.get("LOCALAPPDATA"):
            return Path(os.environ["LOCALAPPDATA"]) / "harness" / "grill"
        return Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state")) / "harness" / "grill"

    @staticmethod
    def key(provider: str, session: str) -> str:
        return hashlib.sha256(f"{provider}:{session}".encode()).hexdigest()

    def new_inbox(self) -> Path:
        """Create an unused inbox whose short, sparse name agents copy cheaply and rarely mistype into a sibling's."""
        parent = self.root / "inboxes"
        parent.mkdir(parents=True, exist_ok=True)
        while True:
            inbox = parent / "".join(secrets.choice(INBOX_ALPHABET) for _ in range(6))
            try:
                inbox.mkdir()
            except FileExistsError:
                continue
            return inbox

    @contextmanager
    def claim(self, provider: str, session: str):
        lock_path = self.root / "locks" / f"{self.key(provider, session)}.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with lock_path.open("a+b") as file:
            if file.tell() == 0:
                file.write(b"0")
                file.flush()
            file.seek(0)
            if os.name == "nt":
                import msvcrt
                lock = lambda: msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
                unlock = lambda: msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                lock = lambda: fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
                unlock = lambda: fcntl.flock(file, fcntl.LOCK_UN)
            try:
                lock()
            except OSError:
                yield False
                return
            try:
                yield True
            finally:
                file.seek(0)
                unlock()

    def _state_path(self, provider: str, session: str) -> Path:
        return self.root / "sessions" / f"{self.key(provider, session)}.json"

    def current(self, provider: str, session: str) -> Interview | None:
        path = self._state_path(provider, session)
        if not path.exists():
            return None
        state = json.loads(path.read_text(encoding="utf-8"))
        return Interview(Path(state["directory"]), int(state["sequence"]))

    def save(self, provider: str, session: str, interview: Interview) -> None:
        atomic_write(self._state_path(provider, session), json.dumps({"directory": str(interview.directory), "sequence": interview.sequence}))

    def reserve_fresh(self, interview: Interview) -> None:
        while interview.source.exists() or interview.source.is_symlink():
            interview.sequence += 1
        interview.source.parent.mkdir(parents=True, exist_ok=True)
        interview.assets.mkdir(parents=True, exist_ok=True)

    def start(self, provider: str, session: str, project: Path) -> Interview:
        if self.root.is_relative_to(project.resolve()):
            raise ValueError("Grill runtime directory must be outside the project")
        interview = self.current(provider, session) or Interview(self.new_inbox())
        self.reserve_fresh(interview)
        self.save(provider, session, interview)
        return interview

    def recover(self, provider: str, session: str, project: Path) -> Interview | None:
        current = self.current(provider, session)
        if current is not None:
            self.reserve_fresh(current)
            self.save(provider, session, current)
            return current
        if self.client is None or self.client.session(provider, session) is None:
            return None
        return self.start(provider, session, project)

    def _outboxes(self, provider: str, session: str) -> list[Path]:
        parent = self.root / "outbox" / self.key(provider, session)
        return sorted(parent.glob("*/publication.json")) if parent.exists() else []

    def _stage(
        self, provider: str, session: str, payload: dict, manifest: list[dict], title: str,
        project: dict[str, str] | None,
    ) -> Path:
        publication_key = str(uuid.uuid4())
        directory = self.root / "outbox" / self.key(provider, session) / publication_key
        directory.mkdir(parents=True, exist_ok=False)
        assets = []
        deadline = time.monotonic() + 60
        try:
            for index, item in enumerate(manifest):
                destination = directory / f"asset-{index:03d}{item['path'].suffix.lower()}"
                if item["media_type"].startswith("video/"):
                    prepare_video(item["path"], destination, deadline)
                else:
                    shutil.copyfile(item["path"], destination)
                with destination.open("rb") as file:
                    digest = hashlib.file_digest(file, "sha256").hexdigest()
                assets.append({key: value for key, value in item.items() if key != "path"} | {
                    "file": destination.name, "byte_size": destination.stat().st_size, "sha256": digest,
                })
            if sum(asset["byte_size"] for asset in assets) > MAX_ROUND_BYTES:
                raise RoundError("Prepared round assets exceed 50 MiB. Shorten or compress the clips and republish.")
        except BaseException:
            shutil.rmtree(directory)
            raise
        staged = {
            "provider": provider, "session_id": session, "title": title,
            "schema_version": SCHEMA_VERSION, "idempotency_key": publication_key,
            "payload": payload, "assets": assets,
        }
        if project is not None:
            staged["project"] = project
        publication = directory / "publication.json"
        atomic_write(publication, json.dumps(staged, ensure_ascii=True))
        return publication

    def _publish_staged(self, publication_path: Path) -> dict:
        try:
            return self._send_staged(publication_path)
        except HostedError as error:
            # A rejection the board will repeat would otherwise retry on every later event.
            if not error.retryable:
                shutil.rmtree(publication_path.parent, ignore_errors=True)
            raise

    def _send_staged(self, publication_path: Path) -> dict:
        if self.client is None:
            raise HostedError("Hosted board configuration is unavailable", "missing_configuration")
        staged = json.loads(publication_path.read_text(encoding="utf-8"))
        key = staged["idempotency_key"]
        request_body = {field: staged[field] for field in ("provider", "session_id", "title", "schema_version", "payload")}
        if "project" in staged:
            request_body["project"] = staged["project"]
        request_body["assets"] = [{k: v for k, v in item.items() if k != "file"} for item in staged["assets"]]
        prepared = self.client.request("POST", "/api/v1/publications/prepare", request_body, key)
        publication = prepared["publication"]
        if publication["status"] != "committed":
            # A retry omits targets for objects the server already holds; commit verifies every asset.
            targets = {target["reference"]: target for target in prepared.get("upload_targets", [])}
            for asset in staged["assets"]:
                target = targets.get(asset["reference"])
                if target is not None:
                    self.client.upload(target, publication_path.parent / asset["file"], asset["media_type"])
        result = self.client.request("POST", f"/api/v1/publications/{publication['id']}/commit", {}, key)
        result["question_count"] = len(staged["payload"]["questions"])
        self._record_publication(staged, result)
        shutil.rmtree(publication_path.parent)
        return result

    def _record_publication(self, staged: dict, result: dict) -> None:
        """Let provider adapters persist confirmation before queued work is removed."""

    def retry_pending(self, provider: str, session: str) -> list[dict]:
        return [self._publish_staged(path) for path in self._outboxes(provider, session)]

    def publish(
        self, provider: str, session: str, title: str = "", *, project: Path | None = None,
        home: Path | None = None,
    ) -> dict | None:
        interview = self.current(provider, session)
        if interview is None or not interview.source.exists():
            return None
        source = interview.source
        old_sequence = interview.sequence
        interview.sequence += 1
        self.reserve_fresh(interview)
        self.save(provider, session, interview)
        if source.is_symlink() or not source.is_file():
            raise RoundError("Round source must be a regular file")
        try:
            payload = validate_round(json.loads(source.read_text(encoding="utf-8-sig")))
        except (json.JSONDecodeError, UnicodeError) as error:
            raise RoundError(str(error)) from error
        assets = interview.directory / "assets" / f"round-{old_sequence:03d}"
        manifest = validate_assets(payload, assets, f"assets/round-{old_sequence:03d}/")
        identity = project_identity(project, home) if project is not None else None
        publication = self._stage(provider, session, payload, manifest, title, identity)
        # Prepare successfully before replacing older queued work. The newest commit becomes the active round.
        for queued in self._outboxes(provider, session):
            if queued != publication:
                shutil.rmtree(queued.parent)
        return self._publish_staged(publication)


def context(event: str, text: str) -> dict:
    return {"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}}


def locations(interview: Interview) -> str:
    return (
        f"Inbox file:\n{interview.source}\n"
        f"Assets directory: {interview.assets}\n"
        f"Assets URL prefix: {interview.assets_url}"
    )


def publication_result(published: dict) -> str:
    return (f"Round {published['round_number']} with {published['question_count']} questions "
            f"available at {published['url']}")


def _last_jsonl_value(path: Path, match: str, key: str, value: str) -> str:
    """Return the latest non-empty string under `key` in records whose `match` field equals `value`."""
    title = ""
    try:
        with path.open(encoding="utf-8", errors="replace") as stream:
            for line in stream:
                if value not in line:
                    continue
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                if isinstance(record, dict) and record.get(match) == value:
                    found = record.get(key)
                    if isinstance(found, str) and found.strip():
                        title = " ".join(found.split())
    except OSError:
        pass
    return title


def session_title(payload: dict, provider: str) -> str:
    """Read the provider's generated session name; empty when it has not produced one yet."""
    session = payload["session_id"]
    if provider == "chatgpt":
        home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
        return _last_jsonl_value(home / "session_index.jsonl", "id", "thread_name", session)
    transcript = payload.get("transcript_path")
    if not isinstance(transcript, str) or not transcript:
        return ""
    return _last_jsonl_value(Path(transcript), "sessionId", "aiTitle", session)


def project_root(payload: dict) -> Path:
    """The project where the session started; the payload cwd follows the agent's `cd` into subdirectories."""
    return Path(os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or Path.cwd())


def handle(payload: dict, provider: str, runtime: InterviewRuntime | None = None) -> dict | None:
    session = payload.get("session_id")
    event = payload.get("hook_event_name")
    if not isinstance(session, str) or not session or event not in {"UserPromptSubmit", "PostToolUse"}:
        return None
    project = project_root(payload)
    runtime = runtime or InterviewRuntime.from_environment(project=project)
    with runtime.claim(provider, session) as acquired:
        return _handle(payload, provider, runtime) if acquired else None


def _handle(payload: dict, provider: str, runtime: InterviewRuntime) -> dict | None:
    event = payload["hook_event_name"]
    session = payload["session_id"]
    prompt = payload.get("prompt", "")
    invocation = bool(isinstance(prompt, str) and re.search(
        r"(?<!\S)" + ("/" if provider == "claude" else r"\$") + r"grill-me-in-cloud(?=\s|$)", prompt))
    tool_input = payload.get("tool_input", {})
    skill_loaded = (
        event == "PostToolUse" and payload.get("tool_name") == "Skill" and
        isinstance(tool_input, dict) and tool_input.get("skill") == "grill-me-in-cloud"
    )
    response = payload.get("tool_response")
    if event == "PostToolUse" and isinstance(response, dict) and (response.get("isError") or response.get("error")):
        return None
    grilling = invocation or skill_loaded or runtime.current(provider, session) is not None
    if runtime.configuration_error is not None:
        return context(event, f"Hosted grill is not configured: {runtime.configuration_error}") if grilling else None
    project = project_root(payload)
    if event == "UserPromptSubmit" or skill_loaded:
        return _prepare(event, provider, session, project, runtime, invocation or skill_loaded, grilling)
    return _publish(payload, provider, session, project, runtime)


def _retry_queued(runtime: InterviewRuntime, provider: str, session: str) -> tuple[str, bool]:
    """Report a round an outage left queued; the flag is set when the interview cannot continue."""
    try:
        published = runtime.retry_pending(provider, session)
    except HostedError as error:
        if not error.retryable:
            return f"The queued round cannot be published: {error}", True
        return f"The queued round is still unpublished ({error}); it retries on the next user message.\n\n", False
    if not published:
        return "", False
    latest = published[-1]
    return publication_result(latest) + "\n\n", False


def _prepare(
    event: str, provider: str, session: str, project: Path, runtime: InterviewRuntime, starting: bool, grilling: bool,
) -> dict | None:
    """Queued rounds retry only here, so ordinary tool calls never wait on the board."""
    try:
        queued, stopped = _retry_queued(runtime, provider, session)
        if stopped:
            return context(event, queued)
        previous = runtime.current(provider, session)
        interview = runtime.start(provider, session, project) if starting else runtime.recover(provider, session, project)
    except (HostedError, OSError, ValueError) as error:
        # Every prompt looks up a hosted session, so an outage stays silent outside grill sessions.
        return context(event, f"Grill setup failed: {error}") if grilling else None
    if interview is None:
        return context(event, queued.rstrip()) if queued else None
    if (starting and event == "UserPromptSubmit") or previous is None or previous.source != interview.source or queued:
        return context(event, queued + locations(interview))
    return None


def _publish(payload: dict, provider: str, session: str, project: Path, runtime: InterviewRuntime) -> dict | None:
    event = payload["hook_event_name"]
    try:
        published = runtime.publish(provider, session, session_title(payload, provider) or session, project=project)
    except RoundError as error:
        return context(
            event,
            f"Round rejected: {error}\n{locations(runtime.current(provider, session))}",
        )
    except HostedError as error:
        if error.retryable:
            return context(event, f"Round not published yet: {error}. It is queued and retries on the user's next message.")
        return context(event, f"Round cannot be published: {error}")
    except (OSError, ValueError) as error:
        return context(event, f"Round cannot be published: {error}")
    if published is None:
        return None
    return context(
        event,
        f"{publication_result(published)}\n{locations(runtime.current(provider, session))}",
    )


def main() -> int:
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    provider = "chatgpt" if "--chatgpt" in sys.argv else "claude"
    payload = {}
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ValueError("hook input must be a JSON object")
        print(json.dumps(handle(payload, provider) or {}))
        return 0
    except KeyboardInterrupt:
        return 130
    except Exception as error:
        reason = f"Cloud interview hook failed ({type(error).__name__}): {error}"
        if provider == "chatgpt":
            event = payload.get("hook_event_name") if isinstance(payload, dict) else None
            output = {"continue": False, "stopReason": reason, "systemMessage": reason} if event == "PostToolUse" else {"decision": "block", "reason": reason}
            print(json.dumps(output))
            return 0
        print(reason, file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
