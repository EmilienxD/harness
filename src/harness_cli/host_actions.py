"""Verified machine-level catalogue actions."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

from harness_cli.manifest import HostAction


class HostActionError(RuntimeError):
    pass


def _github_token() -> str | None:
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token:
        return token
    if shutil.which("gh") is None:
        return None
    try:
        result = subprocess.run(
            ["gh", "auth", "token"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    discovered = result.stdout.strip()
    return discovered if result.returncode == 0 and discovered else None


def _download_request(url: str) -> urllib.request.Request:
    """Build a release download request, authenticating private GitHub assets."""
    match = re.fullmatch(
        r"https://github\.com/([^/]+)/([^/]+)/releases/download/([^/]+)/([^/]+)", url
    )
    if not match:
        return urllib.request.Request(url)
    token = _github_token()
    if not token:
        return urllib.request.Request(url)
    owner, repository, tag, asset_name = match.groups()
    headers = {"Authorization": f"Bearer {token}"}
    metadata_request = urllib.request.Request(
        f"https://api.github.com/repos/{owner}/{repository}/releases/tags/{quote(tag)}",
        headers=headers,
    )
    with urllib.request.urlopen(metadata_request, timeout=60) as response:
        release = json.load(response)
    asset = next((item for item in release.get("assets", []) if item.get("name") == asset_name), None)
    if asset is None or not isinstance(asset.get("url"), str):
        raise HostActionError(f"{url}: release has no asset named {asset_name}")
    return urllib.request.Request(
        asset["url"],
        headers={**headers, "Accept": "application/octet-stream"},
    )


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
        request = _download_request(url)
        with urllib.request.urlopen(request, timeout=60) as response, handle:
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
        handle.close()
        path.unlink(missing_ok=True)
        if isinstance(exc, HostActionError):
            raise
        raise HostActionError(f"could not acquire {url}: {exc}") from exc


def apply(prepared: PreparedAction) -> None:
    action = prepared.action
    if action.type == "uv-tool":
        uv = shutil.which("uv")
        if not uv:
            raise HostActionError("installing a Python host tool requires uv on PATH")
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
            raise HostActionError("removing a Python host tool requires uv on PATH")
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
