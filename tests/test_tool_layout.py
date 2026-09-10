"""Structural contracts for first-party tool payloads."""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

from harness_cli.manifest import discover


LAYERS = {"shared", "claude", "chatgpt"}
ROOT = Path(__file__).resolve().parent.parent


def test_first_party_tools_use_explicit_layered_payloads():
    for tool in discover().values():
        manifest = tomllib.loads((tool.root / "harness.toml").read_text(encoding="utf-8"))
        platforms = manifest.get("platforms", {})
        assert "claude" in platforms, f"{tool.name} must declare Claude support explicitly"
        assert not (tool.root / "targets").exists(), f"{tool.name} still has a targets/ layer"

        for file_spec in manifest.get("files", []):
            layer = str(file_spec["src"]).replace("\\", "/").split("/", 1)[0]
            assert layer in LAYERS, f"{tool.name}: {file_spec['src']} is outside a payload layer"

        for platform, declaration in platforms.items():
            fragment = declaration.get("fragment")
            if fragment:
                normalized = str(fragment).replace("\\", "/")
                allowed_roots = (f"{platform}/", f"hooks/{platform}/")
                assert normalized.startswith(allowed_roots), (
                    f"{tool.name}: {platform} fragment is outside its payload layer"
                )


def test_first_party_skills_do_not_use_dynamic_shell_injection():
    dynamic_shell = re.compile(r"(?m)^\s*(?:!`|```!)")
    for skill in (ROOT / "harness").rglob("SKILL.md"):
        if "itsclaudehistory" in skill.parts:
            continue
        body = skill.read_text(encoding="utf-8")
        assert not dynamic_shell.search(body), (
            f"{skill.relative_to(ROOT)} uses dynamic shell injection; prepare dynamic "
            "context in a hook so the skill body stays cacheable"
        )
