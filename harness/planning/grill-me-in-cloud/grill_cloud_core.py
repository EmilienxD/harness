"""Hosted grill round validation, image discovery, and durable publication."""
from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import shutil
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET
from contextlib import contextmanager
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path

SCHEMA_VERSION = 1
MAX_IMAGE_BYTES = 6 * 1024 * 1024
MAX_ROUND_BYTES = 24 * 1024 * 1024
MAX_IMAGES = 20
MEDIA_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif",
    ".svg": "image/svg+xml",
}


class RoundError(ValueError):
    """The authored round or one of its local assets is invalid."""


class HostedError(RuntimeError):
    def __init__(self, message: str, code: str = "hosted_error", status: int | None = None):
        super().__init__(message)
        self.code = code
        self.status = status


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


class _ImageReferences(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.references: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {name.lower(): value for name, value in attrs if value is not None}
        lowered = tag.lower()
        if lowered == "img" and values.get("src"):
            self.references.append(values["src"])
        if lowered in {"img", "source"} and values.get("srcset"):
            self.references.extend(_srcset_urls(values["srcset"]))


def discover_references(payload: dict) -> list[str]:
    references: list[str] = []
    seen: set[str] = set()
    for question in payload["questions"]:
        parser = _ImageReferences()
        parser.feed(question["explanation_html"])
        parser.close()
        for reference in parser.references:
            if reference not in seen:
                seen.add(reference)
                references.append(reference)
    return references


def _sniff_image(path: Path, declared: str) -> bool:
    sample = path.read_bytes()[:4096]
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
            raise RoundError(f"Unsupported local image reference: {reference}")
        relative = urllib.parse.unquote(parsed.path[len(assets_prefix):])
        if not relative or parsed.query or parsed.fragment or Path(relative).is_absolute():
            raise RoundError(f"Invalid local image reference: {reference}")
        candidate = (root / Path(relative)).resolve(strict=False)
        if not candidate.is_relative_to(root) or not candidate.is_file():
            raise RoundError(f"Local image is missing or escapes the round assets directory: {reference}")
        media_type = MEDIA_TYPES.get(candidate.suffix.lower()) or mimetypes.guess_type(candidate.name)[0]
        if media_type not in MEDIA_TYPES.values() or not _sniff_image(candidate, media_type):
            raise RoundError(f"Unsupported image or media type mismatch: {reference}")
        size = candidate.stat().st_size
        if size > MAX_IMAGE_BYTES:
            raise RoundError(f"Image exceeds 6 MiB: {reference}")
        total += size
        if total > MAX_ROUND_BYTES:
            raise RoundError("Round images exceed 24 MiB")
        if len(manifest) >= MAX_IMAGES:
            raise RoundError("Round contains more than 20 local images")
        manifest.append({
            "reference": reference, "path": candidate, "media_type": media_type,
            "byte_size": size, "sha256": hashlib.sha256(candidate.read_bytes()).hexdigest(),
        })
    return manifest


@dataclass
class Interview:
    directory: Path
    sequence: int = 1

    @property
    def source(self) -> Path:
        return self.directory / "inbox" / f"round-{self.sequence:03d}.json"

    @property
    def assets(self) -> Path:
        return self.directory / "assets" / f"round-{self.sequence:03d}"

    @property
    def assets_url(self) -> str:
        return f"assets/round-{self.sequence:03d}/"


class HostedClient:
    def __init__(self, origin: str, code: str, timeout: float = 15.0):
        if not re.fullmatch(r"\d{4}", code):
            raise ValueError("HARNESS_GRILL_CODE must contain exactly four ASCII digits")
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
            raise ValueError("HARNESS_GRILL_URL must be an HTTP(S) origin without a path")
        self.origin = origin
        self.code = code
        self.timeout = timeout

    @classmethod
    def from_environment(cls, project: Path | None = None) -> "HostedClient":
        origin = os.environ.get("HARNESS_GRILL_URL", "")
        code = os.environ.get("HARNESS_GRILL_CODE", "")
        config_path = project / ".harness" / "grill.json" if project else None
        if config_path and config_path.is_file():
            try:
                config = json.loads(config_path.read_text(encoding="utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError) as error:
                raise ValueError(f"Invalid hosted grill config at {config_path}: {error}") from error
            if not isinstance(config, dict):
                raise ValueError(f"Invalid hosted grill config at {config_path}: expected a JSON object")
            origin = config.get("url", origin)
            code = config.get("code", code)
        if not origin or not code:
            raise ValueError(
                "HARNESS_GRILL_URL and HARNESS_GRILL_CODE are required, or configure .harness/grill.json"
            )
        if not isinstance(origin, str) or not isinstance(code, str):
            raise ValueError("Hosted grill URL and code must be strings")
        return cls(origin, code)

    def request(self, method: str, path: str, body: object | None = None, idempotency_key: str | None = None) -> dict:
        headers = {"Authorization": f"Bearer {self.code}", "Accept": "application/json"}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
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
            if error.code != 409:
                raise HostedError(f"Image upload failed ({error.code})", "upload_failed", error.code) from error
        except (urllib.error.URLError, TimeoutError) as error:
            raise HostedError(f"Image upload failed: {error}", "upload_failed") from error

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
        interview = self.current(provider, session) or Interview(self.root / "inboxes" / self.key(provider, session))
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
        for index, item in enumerate(manifest):
            destination = directory / f"asset-{index:03d}{item['path'].suffix.lower()}"
            shutil.copyfile(item["path"], destination)
            assets.append({key: value for key, value in item.items() if key != "path"} | {"file": destination.name})
        staged = {
            "provider": provider, "session_id": session, "title": title,
            "schema_version": SCHEMA_VERSION, "idempotency_key": publication_key,
            "payload": payload, "assets": assets,
        }
        if project is not None:
            staged["project"] = project
        publication = directory / "publication.json"
        atomic_write(publication, json.dumps(staged, ensure_ascii=False))
        return publication

    def _publish_staged(self, publication_path: Path) -> dict:
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
        shutil.rmtree(publication_path.parent)
        return result

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
        return self._publish_staged(self._stage(provider, session, payload, manifest, title, identity))
