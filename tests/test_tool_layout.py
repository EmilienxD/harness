"""Structural contracts for first-party tool payloads."""

from __future__ import annotations

import tomllib

from harness_cli.manifest import discover


LAYERS = {"shared", "claude", "chatgpt"}


def test_first_party_tools_use_explicit_layered_payloads():
    for tool in discover().values():
        manifest = tomllib.loads((tool.root / "harness.toml").read_text(encoding="utf-8"))
        platforms = manifest.get("platforms", {})
        assert "claude" in platforms, f"{tool.name} must declare Claude support explicitly"
        assert not (tool.root / "targets").exists(), f"{tool.name} still has a targets/ layer"

        for file_spec in manifest["files"]:
            layer = str(file_spec["src"]).replace("\\", "/").split("/", 1)[0]
            assert layer in LAYERS, f"{tool.name}: {file_spec['src']} is outside a payload layer"

        for platform, declaration in platforms.items():
            fragment = declaration.get("fragment")
            if fragment:
                normalized = str(fragment).replace("\\", "/")
                assert normalized.startswith(f"{platform}/"), (
                    f"{tool.name}: {platform} fragment is outside its payload layer"
                )
