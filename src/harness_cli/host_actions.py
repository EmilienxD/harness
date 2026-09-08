"""Verified machine-level catalogue actions."""

from __future__ import annotations

import hashlib
import shutil
import subprocess
import tempfile
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from harness_cli.manifest import HostAction


class HostActionError(RuntimeError):
    pass


@dataclass
class PreparedAction:
    action: HostAction
    artifact: Path | None = None

    def cleanup(self) -> None:
        if self.artifact is not None:
            self.artifact.unlink(missing_ok=True)


def _required_string(action: HostAction, key: str) -> str:
    value = action.data.get(key)
    if not isinstance(value, str) or not value:
        raise HostActionError(f"{action.type} action requires '{key}'")
    return value


def prepare(action: HostAction) -> PreparedAction:
    if action.type == "uv-tool":
        _required_string(action, "source")
        _required_string(action, "package")
        return PreparedAction(action)
    if action.type != "vscode-extension":
        raise HostActionError(f"unsupported host action {action.type}")
    url = _required_string(action, "url")
    expected_digest = _required_string(action, "sha256").lower()
    expected_size = action.data.get("size")
    if not isinstance(expected_size, int) or expected_size <= 0:
        raise HostActionError("vscode-extension action requires a positive 'size'")
    handle = tempfile.NamedTemporaryFile(prefix="harness-", suffix=".vsix", delete=False)
    path = Path(handle.name)
    try:
        with urllib.request.urlopen(url, timeout=60) as response, handle:
            remaining = expected_size + 1
            while remaining:
                chunk = response.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                handle.write(chunk)
                remaining -= len(chunk)
        size = path.stat().st_size
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if size != expected_size:
            raise HostActionError(f"VSIX size mismatch: expected {expected_size}, received {size}")
        if digest != expected_digest:
            raise HostActionError("VSIX SHA-256 mismatch")
        return PreparedAction(action, path)
    except Exception as exc:
        path.unlink(missing_ok=True)
        if isinstance(exc, HostActionError):
            raise
        raise HostActionError(f"could not acquire {url}: {exc}") from exc


def apply(prepared: PreparedAction) -> None:
    action = prepared.action
    if action.type == "uv-tool":
        uv = shutil.which("uv")
        if not uv:
            raise HostActionError("installing the persistent Harness CLI requires uv on PATH")
        command = [
            uv,
            "tool",
            "install",
            "--force",
            "--from",
            _required_string(action, "source"),
            _required_string(action, "package"),
        ]
    else:
        executable = next(
            (found for name in ("code", "code-insiders", "codium") if (found := shutil.which(name))),
            None,
        )
        if not executable:
            raise HostActionError("no supported VS Code command found (tried code, code-insiders, codium)")
        if prepared.artifact is None:
            raise HostActionError("VSIX action was not prepared")
        command = [executable, "--install-extension", str(prepared.artifact), "--force"]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        detail = (result.stderr or result.stdout).strip()
        raise HostActionError(detail or f"host action failed with exit code {result.returncode}")


def is_installed(action: HostAction) -> bool:
    """Return whether an unowned host product is already present."""
    if action.type == "uv-tool":
        uv = shutil.which("uv")
        if not uv:
            return False
        result = subprocess.run([uv, "tool", "list"], capture_output=True, text=True)
        package = _required_string(action, "package").lower()
        return result.returncode == 0 and any(
            line and not line[0].isspace() and line.split()[0].lower() == package
            for line in result.stdout.splitlines()
        )
    if action.type == "vscode-extension":
        executable = next(
            (found for name in ("code", "code-insiders", "codium") if (found := shutil.which(name))),
            None,
        )
        if not executable:
            return False
        result = subprocess.run([executable, "--list-extensions"], capture_output=True, text=True)
        extension_id = _required_string(action, "extension_id").lower()
        return result.returncode == 0 and extension_id in {
            line.strip().lower() for line in result.stdout.splitlines()
        }
    raise HostActionError(f"unsupported host action {action.type}")


def uninstall(action: HostAction) -> None:
    if action.type == "uv-tool":
        uv = shutil.which("uv")
        if not uv:
            raise HostActionError("removing the persistent Harness CLI requires uv on PATH")
        command = [uv, "tool", "uninstall", _required_string(action, "package")]
    elif action.type == "vscode-extension":
        executable = next(
            (found for name in ("code", "code-insiders", "codium") if (found := shutil.which(name))),
            None,
        )
        if not executable:
            raise HostActionError("no supported VS Code command found (tried code, code-insiders, codium)")
        command = [executable, "--uninstall-extension", _required_string(action, "extension_id")]
    else:
        raise HostActionError(f"unsupported host action {action.type}")
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        detail = (result.stderr or result.stdout).strip()
        raise HostActionError(detail or f"host uninstall failed with exit code {result.returncode}")
