"""Structural contracts for first-party tool payloads."""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

from harness_cli.manifest import discover


ROOT = Path(__file__).resolve().parents[2]


def has_payload_files(directory: Path) -> bool:
    return directory.exists() and any(
        path.is_file() and "__pycache__" not in path.parts for path in directory.rglob("*")
    )


def test_first_party_tools_use_root_shared_shallow_platform_overlays():
    for tool in discover().values():
        manifest = tomllib.loads((tool.root / "harness.toml").read_text(encoding="utf-8"))
        platforms = manifest.get("platforms", {})
        assert "claude" in platforms, f"{tool.name} must declare Claude support explicitly"
        assert not (tool.root / "targets").exists(), f"{tool.name} still has a targets/ layer"
        assert not has_payload_files(tool.root / "shared"), f"{tool.name} still has a shared/ layer"
        assert not has_payload_files(tool.root / "claude" / "skills"), (
            f"{tool.name} still mirrors the installed skills/ hierarchy under claude/"
        )
        assert not has_payload_files(tool.root / "chatgpt" / "skills"), (
            f"{tool.name} still mirrors the installed skills/ hierarchy under chatgpt/"
        )
        assert not has_payload_files(tool.root / "claude" / "hooks"), (
            f"{tool.name} still mirrors the installed hooks/ hierarchy under claude/"
        )
        assert not has_payload_files(tool.root / "chatgpt" / "hooks"), (
            f"{tool.name} still mirrors the installed hooks/ hierarchy under chatgpt/"
        )

        shared_skills = [
            path
            for path in tool.root.rglob("SKILL.md")
            if not {"claude", "chatgpt", "runtime"}.intersection(
                path.relative_to(tool.root).parts
            )
        ]
        if len(shared_skills) == 1:
            assert shared_skills[0].parent == tool.root, (
                f"{tool.name}: a single shared skill must live at the package root"
            )
        elif len(shared_skills) > 1:
            assert all(path.parent.parent == tool.root for path in shared_skills), (
                f"{tool.name}: multi-skill packages must use <package>/<skill>/SKILL.md"
            )

        for platform, declaration in platforms.items():
            fragment = declaration.get("fragment")
            if fragment:
                normalized = str(fragment).replace("\\", "/")
                expected = {
                    "claude": "claude/settings.fragment.json",
                    "chatgpt": "chatgpt/hooks.fragment.json",
                }[platform]
                assert normalized == expected, (
                    f"{tool.name}: {platform} fragment must be {expected}"
                )

        metadata_specs = [
            file_spec
            for file_spec in manifest.get("files", [])
            if str(file_spec["dest"]).replace("\\", "/").endswith("/agents/openai.yaml")
            and "chatgpt" in file_spec.get("platforms", [])
        ]
        for file_spec in metadata_specs:
            skill_name = str(file_spec["dest"]).replace("\\", "/").split("/", 1)[0]
            expected = (
                "chatgpt/openai.yaml"
                if len(shared_skills) == 1
                else f"chatgpt/agents/{skill_name}.yaml"
            )
            assert str(file_spec["src"]).replace("\\", "/") == expected, (
                f"{tool.name}: ChatGPT metadata for {skill_name} must be {expected}"
            )


def test_no_catalogue_or_archive_package_has_a_shared_payload_directory():
    shared_directories = [
        path
        for path in (ROOT / "harness").rglob("shared")
        if path.is_dir()
        and has_payload_files(path)
    ]
    assert shared_directories == []


def test_first_party_skills_do_not_use_dynamic_shell_injection():
    dynamic_shell = re.compile(r"(?m)^\s*(?:!`|```!)")
    for skill in (ROOT / "harness").rglob("SKILL.md"):
        body = skill.read_text(encoding="utf-8")
        assert not dynamic_shell.search(body), (
            f"{skill.relative_to(ROOT)} uses dynamic shell injection; prepare dynamic "
            "context in a hook so the skill body stays cacheable"
        )
