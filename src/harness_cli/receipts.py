"""Durable ownership receipts for catalogue installations."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any


SCHEMA_VERSION = 1


def receipt_path() -> Path:
    configured = os.environ.get("HARNESS_STATE_DIR")
    root = Path(configured).expanduser() if configured else Path.home() / ".harness"
    return root / "receipts.json"


def installation_id(scope_root: Path, platform: str) -> str:
    identity = f"{scope_root.resolve()}\0{platform}".encode("utf-8")
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
        return cls(selected, data)

    def installation(self, scope_root: Path, platform: str, create: bool = False) -> dict[str, Any]:
        key = installation_id(scope_root, platform)
        installations = self.data["installations"]
        if create:
            return installations.setdefault(
                key,
                {
                    "scopeRoot": str(scope_root.resolve()),
                    "platform": platform,
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
