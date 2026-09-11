from __future__ import annotations

import hashlib
import tomllib
from pathlib import Path

import pytest

from scripts.aboard_release import PinError, update_pin, verify_action


def test_update_pin_uses_package_version_and_exact_released_bytes(tmp_path: Path):
    package = tmp_path / "package.json"
    package.write_text('{"version":"0.1.0"}', encoding="utf-8")
    vsix = tmp_path / "aboard-0.1.0.vsix"
    vsix.write_bytes(b"released aboard")
    manifest = tmp_path / "harness.toml"
    manifest.write_text(
        '''name = "aboard"\nversion = "0.0.1"\n\n[[actions]]\n'''
        '''type = "vscode-extension"\nurl = "old"\nsize = 1\nsha256 = "old"\n''',
        encoding="utf-8",
    )

    metadata = update_pin(manifest, package, vsix, "0.1.0")

    parsed = tomllib.loads(manifest.read_text(encoding="utf-8"))
    assert parsed["version"] == "0.0.2"
    assert parsed["actions"][0]["url"].endswith(
        "/aboard-v0.1.0/aboard-0.1.0.vsix"
    )
    assert parsed["actions"][0]["size"] == 15
    assert parsed["actions"][0]["sha256"] == hashlib.sha256(b"released aboard").hexdigest()
    assert metadata["file"] == "aboard-0.1.0.vsix"

    first_update = manifest.read_text(encoding="utf-8")
    update_pin(manifest, package, vsix, "0.1.0")
    assert manifest.read_text(encoding="utf-8") == first_update


def test_update_pin_rejects_a_version_that_does_not_match_package(tmp_path: Path):
    package = tmp_path / "package.json"
    package.write_text('{"version":"0.2.0"}', encoding="utf-8")
    vsix = tmp_path / "aboard-0.1.0.vsix"
    vsix.write_bytes(b"released aboard")
    manifest = tmp_path / "harness.toml"
    manifest.write_text('name="aboard"\nversion="0.0.1"\n', encoding="utf-8")

    with pytest.raises(PinError, match="package.json version"):
        update_pin(manifest, package, vsix, "0.1.0")


def test_verify_action_checks_the_downloaded_bytes():
    payload = b"published bytes"
    action = {
        "url": "https://example.test/aboard.vsix",
        "size": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
    }

    verify_action(action, lambda _url: payload)

    with pytest.raises(PinError, match="size"):
        verify_action({**action, "size": len(payload) + 1}, lambda _url: payload)
