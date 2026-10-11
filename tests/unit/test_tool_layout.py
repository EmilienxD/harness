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


def hook_sources(tool) -> list[str]:
    """Package-relative Python sources the manifest installs into ``hooks/``."""
    return [
        str(spec.src).replace("\\", "/")
        for spec in tool.files
        if str(spec.src).endswith(".py")
        and (spec.root == "hooks" or str(spec.dest).replace("\\", "/").startswith("hooks/"))
    ]


def fragment_handlers(fragment: dict):
    for groups in (fragment.get("hooks") or {}).values():
        for group in groups:
            for handler in group.get("hooks", []):
                yield handler


def handler_text(handler: dict) -> str:
    return " ".join([str(handler.get("command", "")), *map(str, handler.get("args", []))])


# A tool's hook is either a payload script the installer copies into `hooks/`
# or a `harness-<tool>-hook` console script from its own runtime package.
CONSOLE_SCRIPT = re.compile(r"(?<![\w-])harness-[a-z0-9-]+-hook(?![\w-])")


def invokes_a_hook(text: str, payloads: set[str]) -> bool:
    return any(name in text for name in payloads) or bool(CONSOLE_SCRIPT.search(text))


def test_every_hook_payload_is_one_provider_neutral_file_named_for_its_tool():
    """`{tool-name}_hook.py`, at the package root, shared by every provider.

    A hook selects its provider from the `--claude`/`--chatgpt` flag the
    installer writes into the settings, so there is never a second copy of a
    payload -- and never a product name in a payload's path.
    """
    for tool in discover().values():
        expected = tool.name.replace("-", "_") + "_hook.py"
        sources = hook_sources(tool)
        entry_points = [src for src in sources if src.endswith("_hook.py")]

        for src in sources:
            assert "/" not in src, (
                f"{tool.name}: hook payload '{src}' must live at the package root"
            )
            assert not re.search(r"claude|chatgpt|codex", src, re.IGNORECASE), (
                f"{tool.name}: hook payload '{src}' names a product"
            )

        # A tool either ships its own hook script or wires a runtime console
        # script; the ones that ship a script ship exactly one.
        assert entry_points in ([], [expected]), (
            f"{tool.name}: hook entry points must be exactly [{expected}], not {entry_points}"
        )


def test_every_installed_hook_command_passes_its_provider_flag():
    """Payload scripts and runtime console scripts are wired the same way."""
    checked = 0
    for tool in discover().values():
        payloads = set(hook_sources(tool))
        for platform, fragment in tool.platform_fragments.items():
            for handler in fragment_handlers(fragment):
                text = handler_text(handler)
                if not invokes_a_hook(text, payloads):
                    continue
                checked += 1
                assert f"--{platform.value}" in text, (
                    f"{tool.name}: the {platform.value} fragment invokes a hook "
                    f"without --{platform.value}: {text}"
                )
    assert checked, "no hook commands were inspected; the fragment shape changed"


def test_no_fragment_still_passes_a_provider_as_a_bare_word():
    """The positional form the runtime hooks used to take is gone."""
    for tool in discover().values():
        payloads = set(hook_sources(tool))
        for fragment in tool.platform_fragments.values():
            for handler in fragment_handlers(fragment):
                if not invokes_a_hook(handler_text(handler), payloads):
                    continue
                tokens = [*str(handler.get("command", "")).split(), *map(str, handler.get("args", []))]
                bare = [token for token in tokens if token in ("claude", "chatgpt")]
                assert not bare, f"{tool.name}: provider passed as a bare word {bare}"


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
                else f"{skill_name}/chatgpt/openai.yaml"
            )
            assert str(file_spec["src"]).replace("\\", "/") == expected, (
                f"{tool.name}: ChatGPT metadata for {skill_name} must be {expected}"
            )
            assert (tool.root / expected).parent.parent.joinpath("SKILL.md").is_file()

        for platform in platforms:
            for payload in tool.expand(platform):
                if payload.root == "skills":
                    assert "chatgpt" not in Path(payload.dest).parts, (
                        f"{tool.name}: source overlay leaked into {platform} skill {payload.dest}"
                    )


def test_no_catalogue_or_archived_package_has_a_shared_payload_directory():
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
