import json
import shutil
from pathlib import Path

import pytest

from harness_cli import installer
from harness_cli.installer import (
    InstallError,
    Target,
    apply_install,
    is_installed,
    plan_install,
    uninstall,
)
from harness_cli.manifest import discover, load_tool

TOOLS = discover()


@pytest.fixture
def target(tmp_path):
    return Target.for_project(tmp_path)


def settings(target):
    return json.loads(target.settings_path.read_text(encoding="utf-8"))


def install(name, target):
    plan = plan_install(TOOLS[name], target)
    apply_install(plan)
    return plan


def claude_files(target):
    return sorted(p.relative_to(target.claude_dir).as_posix() for p in target.claude_dir.rglob("*") if p.is_file())


def test_every_tool_has_a_valid_manifest():
    assert set(TOOLS) >= {"caveman", "commit", "issues"}
    for tool in TOOLS.values():
        assert tool.expand(), f"{tool.name} resolves to no files"


def test_install_writes_only_the_tools_own_files(target):
    install("caveman", target)
    assert claude_files(target) == ["skills/caveman/SKILL.md"]
    assert is_installed(TOOLS["caveman"], target)


def test_install_leaves_no_lock_or_backup(target):
    target.claude_dir.mkdir(parents=True)
    target.settings_path.write_text('{"model": "opus"}', encoding="utf-8")
    install("commit", target)
    install("issues", target)
    assert claude_files(target) == [
        "hooks/commit_UserPromptSubmit_hook.py",
        "hooks/publish_issues_UserPromptSubmit_hook.py",
        "settings.json",
        "skills/commit/SKILL.md",
        "skills/draft-issue/SKILL.md",
        "skills/draft-issues/SKILL.md",
        "skills/map-issues/SKILL.md",
        "skills/publish-issues/SKILL.md",
        "skills/to-spec-draft-issue/SKILL.md",
        "skills/to-spec/SKILL.md",
    ]


def test_install_hook_tool_writes_settings(target):
    install("commit", target)
    entry = settings(target)["hooks"]["UserPromptSubmit"][0]["hooks"][0]
    # With uv available: command="uv", args=["run", "--no-project", "<script>"]
    # Without uv: command="<python>", args=["<script>"]
    if installer.python_command() and installer.python_command()[0] == "uv":
        assert entry["command"] == "uv"
        assert entry["args"][0] == "run"
        assert entry["args"][1] == "--no-project"
        assert entry["args"][2].endswith("/hooks/commit_UserPromptSubmit_hook.py")
    else:
        assert entry["args"][0].endswith("/hooks/commit_UserPromptSubmit_hook.py")
    assert "${PYTHON}" not in entry["command"]


def test_python_uses_uv_when_available(target):
    if not shutil.which("uv"):
        pytest.skip("uv not on PATH")
    install("commit", target)
    entry = settings(target)["hooks"]["UserPromptSubmit"][0]["hooks"][0]
    # When uv is available, prefer it over absolute Python paths
    assert entry["command"] == "uv"
    assert entry["args"][0] == "run"
    assert entry["args"][1] == "--no-project"
    assert entry["args"][2].endswith("/hooks/commit_UserPromptSubmit_hook.py")


def test_python_command_prefers_uv_when_available(monkeypatch):
    monkeypatch.setattr(
        installer.shutil,
        "which",
        lambda name: {"uv": "/usr/bin/uv", "python3": "/usr/bin/python3"}.get(name),
    )
    assert installer.python_command() == ("uv", ["run", "--no-project"])


def test_python_command_falls_back_to_python_when_uv_unavailable(monkeypatch):
    monkeypatch.setattr(
        installer.shutil,
        "which",
        lambda name: {"python3": "/usr/bin/python3", "python": "/usr/bin/python"}.get(name),
    )
    monkeypatch.setattr(installer, "_interpreter_works", lambda path: True)
    assert installer.python_command() == ("/usr/bin/python3", [])


def test_python_command_skips_candidates_that_only_look_installed(monkeypatch):
    # Windows' Store alias passes `which` but errors when actually launched.
    monkeypatch.setattr(
        installer.shutil,
        "which",
        lambda name: {"uv": None, "python3": "C:/stubs/python3.exe", "python": "C:/real/python.exe"}.get(name),
    )
    monkeypatch.setattr(installer, "_interpreter_works", lambda path: "stubs" not in path)
    assert installer.python_command() == ("C:/real/python.exe", [])


def test_python_command_returns_none_when_nothing_works(monkeypatch):
    monkeypatch.setattr(installer.shutil, "which", lambda name: None)
    assert installer.python_command() is None


def test_install_without_python_warns_and_writes_the_fallback(monkeypatch, target):
    monkeypatch.setattr(installer, "python_command", lambda: None)
    plan = plan_install(TOOLS["commit"], target)
    assert "python" in plan.missing_requirements
    apply_install(plan)
    entry = settings(target)["hooks"]["UserPromptSubmit"][0]["hooks"][0]
    assert entry["command"] == installer.FALLBACK_PYTHON
    assert entry["args"][0].endswith("/hooks/commit_UserPromptSubmit_hook.py")


def test_skill_only_tool_does_not_care_about_missing_python(monkeypatch, target):
    monkeypatch.setattr(installer, "python_command", lambda: None)
    assert plan_install(TOOLS["caveman"], target).missing_requirements == []


def test_uninstall_round_trips_after_python_resolution_drift(monkeypatch, target):
    monkeypatch.setattr(installer, "python_command", lambda: ("/usr/bin/python3.12", []))
    install("commit", target)
    monkeypatch.setattr(installer, "python_command", lambda: ("/usr/bin/python3.13", []))
    uninstall(TOOLS["commit"], target)
    assert claude_files(target) == []


def test_reinstall_is_idempotent(target):
    install("commit", target)
    first = settings(target)
    plan = plan_install(TOOLS["commit"], target)
    assert all(f.status == "unchanged" for f in plan.files)
    apply_install(plan)
    assert settings(target) == first


def test_two_hook_tools_stack(target):
    install("commit", target)
    install("issues", target)
    groups = settings(target)["hooks"]["UserPromptSubmit"]
    assert sum(len(g["hooks"]) for g in groups) == 2


def test_uninstall_removes_only_its_own(target):
    install("commit", target)
    install("issues", target)
    uninstall(TOOLS["commit"], target)
    assert not (target.claude_dir / "hooks/commit_UserPromptSubmit_hook.py").exists()
    assert not (target.claude_dir / "skills/commit").exists()
    assert (target.claude_dir / "hooks/publish_issues_UserPromptSubmit_hook.py").is_file()
    groups = settings(target)["hooks"]["UserPromptSubmit"]
    assert sum(len(g["hooks"]) for g in groups) == 1


def test_uninstall_restores_settings_and_leaves_nothing(target):
    target.claude_dir.mkdir(parents=True)
    target.settings_path.write_text('{"model": "opus"}', encoding="utf-8")
    install("commit", target)
    uninstall(TOOLS["commit"], target)
    assert settings(target) == {"model": "opus"}
    assert claude_files(target) == ["settings.json"]


def test_uninstall_drops_a_settings_file_it_created(target):
    install("commit", target)
    uninstall(TOOLS["commit"], target)
    assert claude_files(target) == []


def test_uninstall_of_absent_tool_is_harmless(target):
    target.claude_dir.mkdir(parents=True)
    assert uninstall(TOOLS["caveman"], target) == ["nothing to remove"]


def test_locally_edited_file_is_kept_on_uninstall(target):
    install("caveman", target)
    path = target.claude_dir / "skills/caveman/SKILL.md"
    path.write_text("edited", encoding="utf-8")
    notes = uninstall(TOOLS["caveman"], target)
    assert path.read_text(encoding="utf-8") == "edited"
    assert any("modified since install" in n for n in notes)
    uninstall(TOOLS["caveman"], target, force=True)
    assert not path.exists()


def test_install_overwrites_a_stale_copy(target):
    path = target.claude_dir / "skills/caveman/SKILL.md"
    path.parent.mkdir(parents=True)
    path.write_text("old version", encoding="utf-8")
    plan = plan_install(TOOLS["caveman"], target)
    assert [f.status for f in plan.files] == ["overwrite"]
    apply_install(plan)
    assert path.read_text(encoding="utf-8") != "old version"


@pytest.mark.parametrize(
    "tool, custom",
    [
        ("on-edit-block", "# My custom rules\nserver/** -> docs/STYLE.md\n"),
        ("on-edit-reminder", "# My custom rules\nserver/** -> docs/STYLE.md\n"),
        ("on-read-reminder", "# My custom reminders\n**/models/** -> docs/GLOSSARY.md\n"),
    ],
)
def test_rules_files_are_never_overwritten(target, tool, custom):
    """User-customized .rules files should be preserved on reinstall."""
    install(tool, target)
    rules = target.claude_dir / f"{tool}.rules"
    rules.write_text(custom, encoding="utf-8")

    plan = plan_install(TOOLS[tool], target)
    statuses = {f.dest: f.status for f in plan.files}
    assert statuses[f"{tool}.rules"] == "unchanged"
    apply_install(plan)
    assert rules.read_text(encoding="utf-8") == custom


def test_legacy_artifacts_are_swept(target):
    target.claude_dir.mkdir(parents=True)
    (target.claude_dir / ".harness.lock.json").write_text("{}", encoding="utf-8")
    (target.claude_dir / "settings.json.bak").write_text("{}", encoding="utf-8")
    notes = apply_install(plan_install(TOOLS["caveman"], target))
    assert len(notes) == 2
    assert claude_files(target) == ["skills/caveman/SKILL.md"]


def test_settings_are_backed_up_nowhere(target):
    target.claude_dir.mkdir(parents=True)
    target.settings_path.write_text('{"model": "opus"}', encoding="utf-8")
    install("commit", target)
    assert not (target.claude_dir / "settings.json.bak").exists()


def test_local_settings_target(tmp_path):
    target = Target.for_project(tmp_path, "settings.local.json")
    install("commit", target)
    assert (tmp_path / ".claude/settings.local.json").is_file()
    assert not (tmp_path / ".claude/settings.json").exists()


def test_dry_run_writes_nothing(target):
    plan_install(TOOLS["commit"], target)
    assert not target.claude_dir.exists()


def test_corrupt_settings_is_reported_not_overwritten(target):
    target.claude_dir.mkdir(parents=True)
    target.settings_path.write_text("{not json", encoding="utf-8")
    with pytest.raises(InstallError, match="not valid JSON"):
        install("commit", target)


def test_manifest_rejects_unsafe_dest(tmp_path):
    (tmp_path / "bad").mkdir()
    (tmp_path / "bad/harness.toml").write_text(
        'name="bad"\nversion="1"\ndescription="d"\n[[files]]\nsrc="a"\ndest="../../evil"\n',
        encoding="utf-8",
    )
    with pytest.raises(Exception, match="unsafe dest"):
        load_tool(tmp_path / "bad")


def test_manifest_rejects_unsafe_gitignore_entry(tmp_path):
    (tmp_path / "bad").mkdir()
    (tmp_path / "bad/harness.toml").write_text(
        'name="bad"\nversion="1"\ndescription="d"\ngitignore=["../../etc/passwd"]\n'
        '[[files]]\nsrc="a"\ndest="a"\n',
        encoding="utf-8",
    )
    with pytest.raises(Exception, match="unsafe gitignore entry"):
        load_tool(tmp_path / "bad")


def test_install_gitignores_the_key_file(target, tmp_path):
    # The repo root, not .claude/ — the patterns hide files inside the repo.
    install("commit", target)
    text = (tmp_path / ".gitignore").read_text(encoding="utf-8")
    assert ".claude/commit-ai.key" in text
    assert not (target.claude_dir / ".gitignore").exists()


def test_install_appends_to_an_existing_gitignore(target, tmp_path):
    path = tmp_path / ".gitignore"
    path.write_text("*.pyc\nbuild/\n", encoding="utf-8")
    install("commit", target)
    text = path.read_text(encoding="utf-8")
    assert text.startswith("*.pyc\nbuild/\n")
    assert ".claude/commit-ai.key" in text


def test_reinstall_does_not_duplicate_gitignore_entries(target, tmp_path):
    install("commit", target)
    plan = plan_install(TOOLS["commit"], target)
    assert not plan.gitignore_changed
    apply_install(plan)
    assert (tmp_path / ".gitignore").read_text(encoding="utf-8").count("commit-ai.key") == 1


def test_uninstall_removes_a_gitignore_it_created(target, tmp_path):
    install("commit", target)
    uninstall(TOOLS["commit"], target)
    assert not (tmp_path / ".gitignore").exists()


def test_uninstall_keeps_the_users_own_gitignore_lines(target, tmp_path):
    path = tmp_path / ".gitignore"
    path.write_text("*.pyc\n", encoding="utf-8")
    install("commit", target)
    uninstall(TOOLS["commit"], target)
    assert path.read_text(encoding="utf-8") == "*.pyc\n"


def test_a_tool_without_gitignore_entries_writes_none(target, tmp_path):
    install("caveman", target)
    assert not (tmp_path / ".gitignore").exists()


def test_user_install_gitignores_inside_claude_dir(tmp_path, monkeypatch):
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    target = Target.for_user()
    install("commit", target)
    # No repo to speak of, so the patterns are relative to ~/.claude itself —
    # which is what matters when ~/.claude is kept in a dotfiles repo.
    text = (target.claude_dir / ".gitignore").read_text(encoding="utf-8")
    assert "commit-ai.key" in text
    assert ".claude/" not in text


# --- Stop hooks (redirect-subagents) --------------------------------------


USER_STOP_HOOK = {"type": "command", "command": "python", "args": ["user_stop.py"]}


def _stop_entries(settings_dict):
    return [
        entry
        for group in settings_dict.get("hooks", {}).get("Stop", [])
        for entry in group.get("hooks", [])
    ]


def _write_settings(target, data):
    target.claude_dir.mkdir(parents=True, exist_ok=True)
    target.settings_path.write_text(json.dumps(data), encoding="utf-8")


def test_stop_hook_leaves_sibling_entries_alone(target):
    """A Stop hook the user wrote is not ours to rewrite: installing a tool
    with its own Stop hook adds one entry and touches nothing else."""
    _write_settings(target, {"hooks": {"Stop": [{"hooks": [dict(USER_STOP_HOOK)]}]}})
    install("redirect-subagents", target)
    entries = _stop_entries(settings(target))
    assert USER_STOP_HOOK in entries
    assert not any("_proxied" in e for e in entries)
    host = next(e for e in entries if "redirect_subagents_wait_hook.py" in str(e.get("args")))
    assert host["timeout"] == 600
    assert host["statusMessage"] == "Waiting for redirected background subagents"
    assert "stopHook" not in host


def test_stop_hook_reinstall_is_idempotent(target):
    install("redirect-subagents", target)
    first = settings(target)
    install("redirect-subagents", target)
    assert settings(target) == first


def test_stop_hook_uninstall_leaves_sibling_untouched(target):
    original = {"hooks": {"Stop": [{"hooks": [dict(USER_STOP_HOOK)]}]}}
    _write_settings(target, original)
    install("redirect-subagents", target)
    uninstall(TOOLS["redirect-subagents"], target)
    assert settings(target) == original


def test_stop_hook_uninstall_alone_leaves_no_settings(target):
    install("redirect-subagents", target)
    uninstall(TOOLS["redirect-subagents"], target)
    # Nothing else in the file: uninstall removes it entirely.
    assert not target.settings_path.exists()


# --- healing settings written by the retired stopHook convention -----------


def _proxied_settings():
    """What one version of redirect-subagents used to write: the user's hook
    rewritten to run through the wait script, its argv kept under `_proxied`."""
    return {
        "hooks": {
            "Stop": [
                {
                    "hooks": [
                        {
                            "type": "command",
                            "command": "uv",
                            "args": ["run", "wait_hook.py", "-s", "python", "user_stop.py"],
                            "_proxied": ["python", "user_stop.py"],
                        }
                    ]
                }
            ]
        }
    }


def test_install_restores_proxied_hooks(target):
    _write_settings(target, _proxied_settings())
    install("caveman", target)  # any tool: the heal is not one tool's business
    assert _stop_entries(settings(target)) == [USER_STOP_HOOK]


def test_install_restores_proxied_hooks_when_that_is_the_only_change(target):
    """A heal with nothing else to do still reaches disk — the plan compares
    against the file as found, not against the healed copy."""
    _write_settings(target, _proxied_settings())
    plan = install("caveman", target)
    assert plan.settings_changed
    assert _stop_entries(settings(target)) == [USER_STOP_HOOK]


def test_uninstall_restores_proxied_hooks(target):
    settings_data = _proxied_settings()
    _write_settings(target, settings_data)
    install("redirect-subagents", target)
    uninstall(TOOLS["redirect-subagents"], target)
    assert _stop_entries(settings(target)) == [USER_STOP_HOOK]


def test_starter_files_are_never_overwritten(target):
    """subagents.json is edited by the user after install; reinstall/upgrade
    must leave it alone, exactly like the .rules templates."""
    install("redirect-subagents", target)
    config = target.claude_dir / "harness" / "subagents.json"
    config.write_text(json.dumps({"Explore": "auto"}), encoding="utf-8")
    plan = plan_install(TOOLS["redirect-subagents"], target)
    apply_install(plan)
    assert json.loads(config.read_text(encoding="utf-8")) == {"Explore": "auto"}
