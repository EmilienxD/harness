import json

import pytest

from harness_cli.installer import InstallError, Target, apply_install, plan_install, uninstall
from harness_cli.manifest import discover, load_tool

TOOLS = discover()


@pytest.fixture
def target(tmp_path):
    return Target.for_project(tmp_path)


def settings(target):
    return json.loads(target.settings_path.read_text(encoding="utf-8"))


def install(name, target, **kw):
    plan = plan_install(TOOLS[name], target)
    apply_install(plan, **kw)
    return plan


def test_every_tool_has_a_valid_manifest():
    assert set(TOOLS) >= {"caveman", "commit", "publish-issues"}
    for tool in TOOLS.values():
        assert tool.expand(), f"{tool.name} resolves to no files"


def test_install_skill_only_tool(target):
    install("caveman", target)
    assert (target.claude_dir / "skills/caveman/SKILL.md").is_file()
    assert not target.settings_path.exists()  # no fragment -> no settings churn


def test_install_hook_tool_writes_settings(target):
    install("commit", target)
    assert (target.claude_dir / "hooks/commit_user_prompt_submit_hook.py").is_file()
    assert (target.claude_dir / "skills/commit/SKILL.md").is_file()
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
    uninstall("commit", target)
    assert not (target.claude_dir / "hooks/commit_user_prompt_submit_hook.py").exists()
    assert not (target.claude_dir / "skills/commit").exists()
    assert (target.claude_dir / "hooks/publish_issues.py").is_file()
    groups = settings(target)["hooks"]["UserPromptSubmit"]
    assert sum(len(g["hooks"]) for g in groups) == 1


def test_uninstall_restores_original_settings(target):
    target.claude_dir.mkdir(parents=True)
    target.settings_path.write_text('{"model": "opus"}', encoding="utf-8")
    install("commit", target)
    uninstall("commit", target)
    assert settings(target) == {"model": "opus"}
    assert not target.lock_path.exists()


def test_install_refuses_to_clobber_a_foreign_file(target):
    path = target.claude_dir / "skills/caveman/SKILL.md"
    path.parent.mkdir(parents=True)
    path.write_text("mine", encoding="utf-8")
    with pytest.raises(InstallError, match="locally modified"):
        install("caveman", target)
    assert path.read_text(encoding="utf-8") == "mine"
    install("caveman", target, force=True)
    assert path.read_text(encoding="utf-8") != "mine"


def test_locally_edited_file_is_kept_on_uninstall(target):
    install("caveman", target)
    path = target.claude_dir / "skills/caveman/SKILL.md"
    path.write_text("edited", encoding="utf-8")
    uninstall("caveman", target)
    assert path.read_text(encoding="utf-8") == "edited"


def test_upgrade_removes_files_dropped_from_the_manifest(target, tmp_path):
    install("caveman", target)
    stale = target.claude_dir / "skills/caveman/OLD.md"
    stale.write_text("x", encoding="utf-8")
    lock = target.read_lock()
    lock["tools"]["caveman"]["files"].append({"path": "skills/caveman/OLD.md", "sha256": ""})
    target.write_lock(lock)
    apply_install(plan_install(TOOLS["caveman"], target))
    assert not stale.exists()


def test_settings_are_backed_up_before_the_first_write(target):
    target.claude_dir.mkdir(parents=True)
    target.settings_path.write_text('{"model": "opus"}', encoding="utf-8")
    install("commit", target)
    backup = target.claude_dir / "settings.json.bak"
    assert json.loads(backup.read_text(encoding="utf-8")) == {"model": "opus"}


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
