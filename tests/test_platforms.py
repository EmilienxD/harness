import json
from pathlib import Path

import pytest

from harness_cli import cli as cli_module
from harness_cli.cli import main
from harness_cli.installer import InstallError, Target, apply_install, plan_install, uninstall
from harness_cli.manifest import SupportStatus, load_tool
from harness_cli.platforms import Platform


def make_tool(root: Path):
    directory = root / "portable"
    (directory / "shared").mkdir(parents=True)
    (directory / "claude").mkdir()
    (directory / "chatgpt").mkdir()
    (directory / "shared/SKILL.md").write_text("shared skill", encoding="utf-8")
    (directory / "claude/hook.py").write_text("claude", encoding="utf-8")
    (directory / "chatgpt/hook.py").write_text("chatgpt", encoding="utf-8")
    (directory / "chatgpt.fragment.json").write_text(
        json.dumps(
            {
                "hooks": {
                    "UserPromptSubmit": [
                        {
                            "hooks": [
                                {"type": "command", "command": "${HOOKS_DIR}/hook.py"}
                            ]
                        }
                    ]
                }
            }
        ),
        encoding="utf-8",
    )
    (directory / "harness.toml").write_text(
        """
name = "portable"
version = "1.0.0"
description = "fixture"

[platforms.chatgpt]
status = "supported"
fragment = "chatgpt.fragment.json"

[[files]]
src = "shared/SKILL.md"
dest = "portable/SKILL.md"
root = "skills"

[[files]]
src = "claude/hook.py"
dest = "hook.py"
root = "hooks"
platforms = ["claude"]

[[files]]
src = "chatgpt/hook.py"
dest = "hook.py"
root = "hooks"
platforms = ["chatgpt"]
""".strip(),
        encoding="utf-8",
    )
    return load_tool(directory)


def test_legacy_manifests_remain_claude_only(tmp_path):
    directory = tmp_path / "legacy"
    directory.mkdir()
    (directory / "SKILL.md").write_text("legacy", encoding="utf-8")
    (directory / "harness.toml").write_text(
        'name="legacy"\nversion="1"\ndescription="fixture"\n'
        '[[files]]\nsrc="SKILL.md"\ndest="skills/legacy/SKILL.md"\n',
        encoding="utf-8",
    )
    tool = load_tool(directory)
    assert tool.support_for(Platform.CLAUDE).status is SupportStatus.SUPPORTED
    assert tool.support_for(Platform.CHATGPT).status is SupportStatus.UNSUPPORTED


def test_adapters_map_shared_and_specific_payloads_to_native_roots(tmp_path):
    tool = make_tool(tmp_path)
    target = Target.for_project(tmp_path / "project", platform=Platform.CHATGPT)
    plan = plan_install(tool, target)
    apply_install(plan)

    assert (target.scope_root / ".agents/skills/portable/SKILL.md").read_text() == "shared skill"
    assert (target.scope_root / ".codex/hooks/hook.py").read_text() == "chatgpt"
    assert not (target.scope_root / ".claude").exists()
    config = json.loads((target.scope_root / ".codex/hooks.json").read_text())
    command = config["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"]
    assert command == (target.scope_root / ".codex/hooks/hook.py").as_posix()


def test_chatgpt_keeps_python_launcher_and_script_in_native_command(tmp_path, monkeypatch):
    tool = make_tool(tmp_path / "source")
    fragment_path = tool.root / "chatgpt.fragment.json"
    fragment = json.loads(fragment_path.read_text(encoding="utf-8"))
    fragment["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"] = (
        '${PYTHON} "${HOOKS_DIR}/hook.py" --flag'
    )
    fragment_path.write_text(json.dumps(fragment), encoding="utf-8")
    tool = load_tool(tool.root)
    monkeypatch.setattr(
        "harness_cli.installer.python_command",
        lambda: ("uv", ["run", "--no-project"]),
    )

    target = Target.for_project(tmp_path / "project", platform=Platform.CHATGPT)
    apply_install(plan_install(tool, target))

    config = json.loads(target.settings_path.read_text(encoding="utf-8"))
    entry = config["hooks"]["UserPromptSubmit"][0]["hooks"][0]
    script = (target.scope_root / ".codex/hooks/hook.py").as_posix()
    assert entry["command"] == f'uv run --no-project "{script}" --flag'
    assert "args" not in entry


def test_chatgpt_install_and_uninstall_round_trip_preserves_user_config(tmp_path):
    tool = make_tool(tmp_path)
    target = Target.for_project(tmp_path / "project", platform="chatgpt")
    target.settings_path.parent.mkdir(parents=True)
    target.settings_path.write_text('{"user": true}', encoding="utf-8")

    apply_install(plan_install(tool, target))
    uninstall(tool, target)

    assert json.loads(target.settings_path.read_text()) == {"user": True}
    assert not (target.scope_root / ".agents").exists()
    assert not (target.scope_root / ".codex/hooks").exists()


def test_chatgpt_user_install_uses_home_roots_and_reinstalls_idempotently(tmp_path, monkeypatch):
    tool = make_tool(tmp_path / "source")
    home = tmp_path / "home"
    monkeypatch.setattr("pathlib.Path.home", lambda: home)
    target = Target.for_user(platform="chatgpt")

    first = plan_install(tool, target)
    apply_install(first)
    second = plan_install(tool, target)

    assert all(action.status == "unchanged" for action in second.files)
    assert not second.settings_changed
    assert (home / ".agents/skills/portable/SKILL.md").is_file()
    assert (home / ".codex/hooks/hook.py").is_file()
    uninstall(tool, target)
    assert not (home / ".agents").exists()
    assert not (home / ".codex").exists()


def test_chatgpt_rejects_claude_local_config(tmp_path):
    with pytest.raises(InstallError, match="--local is not supported"):
        Target.for_project(tmp_path, "settings.local.json", platform="chatgpt")


def test_cli_reports_unsupported_and_replacement_states(tmp_path, capsys):
    assert main(["list", "--platform", "chatgpt", "--dir", str(tmp_path)]) == 0
    output = capsys.readouterr().out
    assert "caveman" in output and "[unsupported]" in output
    assert "create-skill" in output and "[replacement:" in output

    assert main(["install", "caveman", "--platform", "chatgpt", "--dir", str(tmp_path)]) == 1
    assert "unsupported for the ChatGPT target" in capsys.readouterr().err

    assert main(["install", "create-skill", "--platform", "chatgpt", "--dir", str(tmp_path)]) == 1
    assert "built-in skill creator" in capsys.readouterr().err
    assert not (tmp_path / ".agents").exists()
    assert not (tmp_path / ".codex").exists()


def test_cli_info_is_platform_aware(tmp_path, capsys):
    assert main(["info", "create-skill", "--platform", "chatgpt", "--dir", str(tmp_path)]) == 0
    output = capsys.readouterr().out
    assert "ChatGPT: replacement" in output
    assert "Replacement: ChatGPT's built-in skill creator" in output


def test_all_cli_operations_use_the_selected_adapter(tmp_path, monkeypatch, capsys):
    tool = make_tool(tmp_path / "source")
    project = tmp_path / "project"
    monkeypatch.setattr(cli_module, "discover", lambda: {tool.name: tool})

    common = ["--platform", "chatgpt", "--dir", str(project)]
    assert main(["install", tool.name, *common]) == 0
    assert (project / ".agents/skills/portable/SKILL.md").is_file()
    capsys.readouterr()

    assert main(["list", *common]) == 0
    assert "* portable" in capsys.readouterr().out
    assert main(["info", tool.name, *common]) == 0
    assert ".agents/skills/portable/SKILL.md" in capsys.readouterr().out
    assert main(["upgrade", *common]) == 0
    assert "portable" in capsys.readouterr().out
    assert main(["uninstall", tool.name, *common]) == 0
    capsys.readouterr()
    assert not (project / ".agents").exists()
    assert not (project / ".codex").exists()


def test_manifest_requires_replacement_text(tmp_path):
    directory = tmp_path / "bad"
    directory.mkdir()
    (directory / "a").write_text("a", encoding="utf-8")
    (directory / "harness.toml").write_text(
        'name="bad"\nversion="1"\ndescription="fixture"\n'
        '[platforms.chatgpt]\nstatus="replacement"\n'
        '[[files]]\nsrc="a"\ndest="a"\n',
        encoding="utf-8",
    )
    with pytest.raises(Exception, match="needs 'replacement'"):
        load_tool(directory)
