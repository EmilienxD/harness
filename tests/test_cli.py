import json

import pytest

from harness_cli.cli import main
from harness_cli.installer import Target, apply_install, plan_install
from harness_cli.manifest import discover

TOOLS = discover()


@pytest.fixture
def home(tmp_path_factory, monkeypatch):
    """A fake home directory, so --user installs land somewhere disposable.

    Deliberately not `tmp_path`: the tests below assert that a user-scope
    install and a project-scope install don't touch each other, which is
    vacuous if both resolve to the same directory.
    """
    path = tmp_path_factory.mktemp("home")
    monkeypatch.setenv("HOME", str(path))
    monkeypatch.setenv("USERPROFILE", str(path))
    monkeypatch.setattr("pathlib.Path.home", lambda: path)
    return path


def settings(path):
    return json.loads(path.read_text(encoding="utf-8"))


def test_default_scope_is_the_project(tmp_path, home):
    assert main(["install", "caveman", "--dir", str(tmp_path)]) == 0
    assert (tmp_path / ".claude/skills/caveman/SKILL.md").is_file()
    assert not (home / ".claude").exists()


def test_user_scope_installs_into_home(tmp_path, home):
    assert main(["install", "caveman", "--user"]) == 0
    assert (home / ".claude/skills/caveman/SKILL.md").is_file()
    assert not (tmp_path / ".claude").exists()


def test_global_is_an_alias_for_user(home):
    assert main(["install", "caveman", "--global"]) == 0
    assert (home / ".claude/skills/caveman/SKILL.md").is_file()


def test_user_scope_hook_path_is_absolute(home):
    """`${CLAUDE_PROJECT_DIR}` would point at whatever project is open, not at
    the hook, so a machine-wide install has to bake in a real path."""
    main(["install", "commit", "--user"])
    entry = settings(home / ".claude/settings.json")["hooks"]["UserPromptSubmit"][0]["hooks"][0]
    # With uv: args=["run", "<absolute-path>"], without: args=["<absolute-path>"]
    script_path = entry["args"][-1]  # Last arg is always the script path
    assert "${CLAUDE_PROJECT_DIR}" not in script_path
    assert script_path.startswith(home.as_posix())
    assert (home / ".claude/hooks/commit_UserPromptSubmit_hook.py").is_file()


def test_project_scope_hook_path_uses_the_placeholder(tmp_path, home):
    main(["install", "commit", "--dir", str(tmp_path)])
    entry = settings(tmp_path / ".claude/settings.json")["hooks"]["UserPromptSubmit"][0]["hooks"][0]
    # With uv: args=["run", "${CLAUDE_PROJECT_DIR}/..."], without: args=["${CLAUDE_PROJECT_DIR}/..."]
    script_path = entry["args"][-1]  # Last arg is always the script path
    assert script_path == "${CLAUDE_PROJECT_DIR}/.claude/hooks/commit_UserPromptSubmit_hook.py"


def test_user_and_project_installs_are_independent(tmp_path, home):
    main(["install", "commit", "--user"])
    main(["install", "commit", "--dir", str(tmp_path)])
    main(["uninstall", "commit", "--dir", str(tmp_path)])
    assert not (tmp_path / ".claude").exists()
    assert (home / ".claude/skills/commit/SKILL.md").is_file()


def test_user_scope_uninstall_round_trips(home):
    main(["install", "commit", "issues", "--user"])
    main(["uninstall", "all", "--user"])
    assert list((home / ".claude").rglob("*")) == []


def test_user_rejects_local(home, capsys):
    assert main(["install", "caveman", "--user", "--local"]) == 1
    assert "mutually exclusive" in capsys.readouterr().err


def test_user_rejects_dir(home, tmp_path, capsys):
    assert main(["install", "caveman", "--user", "--dir", str(tmp_path)]) == 1
    assert "--dir applies to a project install" in capsys.readouterr().err


def test_list_reflects_the_scope_it_is_asked_about(tmp_path, home, capsys):
    main(["install", "caveman", "--user"])
    capsys.readouterr()

    main(["list", "--user"])
    assert "* caveman" in capsys.readouterr().out

    main(["list", "--dir", str(tmp_path)])
    assert "* caveman" not in capsys.readouterr().out


def test_unknown_tool_is_reported(tmp_path, capsys):
    assert main(["install", "nope", "--dir", str(tmp_path)]) == 1
    assert "unknown tool" in capsys.readouterr().err


def test_dry_run_writes_nothing(tmp_path, capsys):
    assert main(["install", "commit", "--dir", str(tmp_path), "--dry"]) == 0
    assert "dry run" in capsys.readouterr().out
    assert not (tmp_path / ".claude").exists()


def test_upgrade_only_touches_installed_tools(tmp_path, home, capsys):
    target = Target.for_project(tmp_path)
    apply_install(plan_install(TOOLS["caveman"], target))
    capsys.readouterr()

    assert main(["upgrade", "--dir", str(tmp_path)]) == 0
    out = capsys.readouterr().out
    assert "caveman" in out
    assert "commit" not in out
