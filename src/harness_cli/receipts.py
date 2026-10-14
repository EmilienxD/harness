"""Durable ownership receipts for catalogue installations."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

import portalocker


SCHEMA_VERSION = 1
OWNERSHIP_STATES = {"selected", "dependency", "retained"}


def package_ownership(receipt: dict[str, Any]) -> str:
    """Read current ownership, including receipts written before ownership states existed."""
    ownership = receipt.get("ownership")
    if ownership in OWNERSHIP_STATES:
        return ownership
    return "selected" if receipt.get("explicit") is True else "dependency"


def receipt_path() -> Path:
    configured = os.environ.get("HARNESS_STATE_DIR")
    root = Path(configured).expanduser() if configured else Path.home() / ".harness"
    return root / "receipts.json"


@contextmanager
def installation_lock(path: Path | None = None, *, timeout: float = 60) -> Iterator[None]:
    """Exclude other installer processes that share this receipt store."""
    selected = path or receipt_path()
    selected.parent.mkdir(parents=True, exist_ok=True)
    lock_path = selected.with_name(f".{selected.name}.lock")
    try:
        with portalocker.Lock(lock_path, mode="a", timeout=timeout):
            yield
    except portalocker.exceptions.LockException as exc:
        raise ValueError(f"could not acquire Harness installer lock {lock_path}: {exc}") from exc


def installation_id(scope_root: Path, platform: str, scope: str | None = None) -> str:
    identity_text = f"{scope_root.resolve()}\0{platform}"
    if scope is not None:
        identity_text += f"\0{scope}"
    identity = identity_text.encode("utf-8")
    return hashlib.sha256(identity).hexdigest()[:20]


@dataclass
class ReceiptStore:
    path: Path
    data: dict[str, Any]

    @classmethod
    def load(cls, path: Path | None = None) -> "ReceiptStore":
        selected = path or receipt_path()
        if not selected.is_file():
            return cls(selected, {"version": SCHEMA_VERSION, "installations": {}})
        try:
            data = json.loads(selected.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError(f"invalid Harness receipt store {selected}: {exc}") from exc
        if not isinstance(data, dict) or data.get("version") != SCHEMA_VERSION:
            raise ValueError(f"unsupported Harness receipt store at {selected}")
        if not isinstance(data.get("installations"), dict):
            raise ValueError(f"invalid Harness receipt store at {selected}")
        for key, installation in data["installations"].items():
            if not isinstance(key, str) or not isinstance(installation, dict):
                raise ValueError(f"invalid Harness receipt store at {selected}")
            packages = installation.get("packages")
            if not isinstance(packages, dict):
                raise ValueError(f"invalid Harness receipt store at {selected}")
            for name, receipt in packages.items():
                if not isinstance(name, str) or not isinstance(receipt, dict):
                    raise ValueError(f"invalid Harness receipt store at {selected}")
                if not isinstance(receipt.get("version"), str):
                    raise ValueError(f"invalid Harness receipt store at {selected}")
                if "ownership" in receipt and receipt["ownership"] not in OWNERSHIP_STATES:
                    raise ValueError(f"invalid Harness receipt store at {selected}")
                files = receipt.get("files", [])
                if not isinstance(files, list) or any(
                    not isinstance(record, dict)
                    or not isinstance(record.get("path"), str)
                    or not isinstance(record.get("owned"), bool)
                    for record in files
                ):
                    raise ValueError(f"invalid Harness receipt store at {selected}")
                links = receipt.get("links", [])
                if not isinstance(links, list) or any(
                    not isinstance(record, dict)
                    or not isinstance(record.get("path"), str)
                    or not isinstance(record.get("target"), str)
                    for record in links
                ):
                    raise ValueError(f"invalid Harness receipt store at {selected}")
                if receipt.get("skillMode", "copy") not in {"copy", "symlink"}:
                    raise ValueError(f"invalid Harness receipt store at {selected}")
                actions = receipt.get("actions", [])
                if not isinstance(actions, list) or any(
                    not isinstance(action, dict) or not isinstance(action.get("type"), str)
                    for action in actions
                ):
                    raise ValueError(f"invalid Harness receipt store at {selected}")
        return cls(selected, data)

    def installation(self, scope_root: Path, platform: str, create: bool = False, *, scope: str | None = None) -> dict[str, Any]:
        key = installation_id(scope_root, platform, scope)
        installations = self.data["installations"]
        if create:
            return installations.setdefault(
                key,
                {
                    "scopeRoot": str(scope_root.resolve()),
                    "platform": platform,
                    **({"scope": scope} if scope is not None else {}),
                    "packages": {},
                },
            )
        return installations.get(key, {"packages": {}})

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(self.data, indent=2, sort_keys=True) + "\n"
        handle, temporary = tempfile.mkstemp(prefix="receipts-", suffix=".json", dir=self.path.parent)
        try:
            with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass

    def prune(self) -> None:
        empty = [
            key
            for key, value in self.data["installations"].items()
            if not value.get("packages")
        ]
        for key in empty:
            del self.data["installations"][key]
        if not self.data["installations"]:
            self.path.unlink(missing_ok=True)
            try:
                self.path.parent.rmdir()
            except OSError:
                pass
        else:
            self.save()
