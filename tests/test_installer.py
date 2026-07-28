import json

import pytest

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
    assert set(TOOLS) >= {"caveman", "commit", "publish-issues"}
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
    install("publish-issues", target)
    assert claude_files(target) == [
        "hooks/commit_user_prompt_submit_hook.py",
        "hooks/publish_issues.py",
        "settings.json",
        "skills/commit/SKILL.md",
        "skills/draft-issues/SKILL.md",
        "skills/map-issues/SKILL.md",
        "skills/publish-issues/SKILL.md",
    ]


def test_install_hook_tool_writes_settings(target):
    install("commit", target)
    entry = settings(target)["hooks"]["UserPromptSubmit"][0]["hooks"][0]
    assert entry["args"][0].endswith("/hooks/commit_user_prompt_submit_hook.py")
    assert "${PYTHON}" not in entry["command"]


def test_reinstall_is_idempotent(target):
    install("commit", target)
    first = settings(target)
    plan = plan_install(TOOLS["commit"], target)
    assert all(f.status == "unchanged" for f in plan.files)
    apply_install(plan)
    assert settings(target) == first


def test_two_hook_tools_stack(target):
    install("commit", target)
    install("publish-issues", target)
    groups = settings(target)["hooks"]["UserPromptSubmit"]
    assert sum(len(g["hooks"]) for g in groups) == 2


def test_uninstall_removes_only_its_own(target):
    install("commit", target)
    install("publish-issues", target)
    uninstall(TOOLS["commit"], target)
    assert not (target.claude_dir / "hooks/commit_user_prompt_submit_hook.py").exists()
    assert not (target.claude_dir / "skills/commit").exists()
    assert (target.claude_dir / "hooks/publish_issues.py").is_file()
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
