"""Create and verify immutable catalogue pins for Aboard releases."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import tomllib
import urllib.request
from urllib.parse import quote
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any


REPOSITORY = "https://github.com/EmilienxD/harness"


class PinError(RuntimeError):
    """A release cannot safely be represented by the catalogue pin."""


def _replace_once(text: str, pattern: str, replacement: str, label: str) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.MULTILINE)
    if count != 1:
        raise PinError(f"could not update {label}")
    return updated


def update_pin(
    manifest_path: Path, package_path: Path, vsix_path: Path, version: str
) -> dict[str, Any]:
    package_version = json.loads(package_path.read_text(encoding="utf-8")).get("version")
    if package_version != version:
        raise PinError(
            f"package.json version {package_version!r} does not match release {version!r}"
        )
    expected_name = f"aboard-{version}.vsix"
    if vsix_path.name != expected_name:
        raise PinError(f"VSIX must be named {expected_name}, got {vsix_path.name}")

    payload = vsix_path.read_bytes()
    metadata = {
        "version": version,
        "file": expected_name,
        "size": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "url": f"{REPOSITORY}/releases/download/aboard-v{version}/{expected_name}",
    }
    text = manifest_path.read_text(encoding="utf-8")
    current = tomllib.loads(text)
    existing_action = next(
        (
            action
            for action in current.get("actions", [])
            if action.get("type") == "vscode-extension"
        ),
        None,
    )
    if existing_action is not None and all(
        existing_action.get(key) == metadata[key] for key in ("url", "size", "sha256")
    ):
        return metadata
    parts = str(current["version"]).split(".")
    if len(parts) != 3 or not all(part.isdigit() for part in parts):
        raise PinError("catalogue package version must be numeric major.minor.patch")
    parts[2] = str(int(parts[2]) + 1)

    text = _replace_once(text, r'^version = "[^"]+"$', f'version = "{".".join(parts)}"', "catalogue version")
    text = _replace_once(text, r'^url = "[^"]+"$', f'url = "{metadata["url"]}"', "release URL")
    text = _replace_once(text, r"^size = \d+$", f'size = {metadata["size"]}', "release size")
    text = _replace_once(text, r'^sha256 = "[^"]+"$', f'sha256 = "{metadata["sha256"]}"', "release digest")
    manifest_path.write_text(text, encoding="utf-8")
    return metadata


def _download(url: str) -> bytes:
    headers: dict[str, str] = {}
    token = os.environ.get("GH_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    match = re.fullmatch(
        r"https://github\.com/([^/]+)/([^/]+)/releases/download/([^/]+)/([^/]+)", url
    )
    if token and match:
        owner, repository, tag, asset_name = match.groups()
        release_request = urllib.request.Request(
            f"https://api.github.com/repos/{owner}/{repository}/releases/tags/{quote(tag)}",
            headers=headers,
        )
        with urllib.request.urlopen(release_request, timeout=60) as response:
            release = json.load(response)
        asset = next(
            (candidate for candidate in release["assets"] if candidate["name"] == asset_name),
            None,
        )
        if asset is None:
            raise PinError(f"{url}: release has no asset named {asset_name}")
        url = asset["url"]
        headers["Accept"] = "application/octet-stream"
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def verify_action(
    action: Mapping[str, Any], fetch: Callable[[str], bytes] = _download
) -> None:
    url = str(action["url"])
    payload = fetch(url)
    if len(payload) != action["size"]:
        raise PinError(f"{url}: size is {len(payload)}, expected {action['size']}")
    digest = hashlib.sha256(payload).hexdigest()
    if digest != str(action["sha256"]).lower():
        raise PinError(f"{url}: sha256 is {digest}, expected {action['sha256']}")


def verify_pins(catalogue: Path) -> int:
    count = 0
    for path in sorted(catalogue.rglob("harness.toml")):
        manifest = tomllib.loads(path.read_text(encoding="utf-8"))
        for action in manifest.get("actions", []):
            if action.get("type") == "vscode-extension":
                verify_action(action)
                print(f"verified {path}: {action['url']}")
                count += 1
    if count == 0:
        raise PinError(f"no vscode-extension actions found below {catalogue}")
    return count


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    update = commands.add_parser("update-pin")
    update.add_argument("--version", required=True)
    update.add_argument("--vsix", type=Path, required=True)
    update.add_argument("--manifest", type=Path, default=Path("harness/extension/aboard/harness.toml"))
    update.add_argument("--package", type=Path, default=Path("apps/aboard/package.json"))
    verify = commands.add_parser("verify-pins")
    verify.add_argument("--catalogue", type=Path, default=Path("harness"))
    args = parser.parse_args(argv)
    try:
        if args.command == "update-pin":
            print(json.dumps(update_pin(args.manifest, args.package, args.vsix, args.version)))
        else:
            verify_pins(args.catalogue)
    except (OSError, KeyError, ValueError, PinError, tomllib.TOMLDecodeError) as exc:
        parser.error(str(exc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
