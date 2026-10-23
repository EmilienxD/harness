"""Real catalogue payload installation and ownership for the shared Pi skills."""

import pytest

from harness_cli.installer import CatalogueInstaller, Target, installed_packages
from harness_cli.manifest import SupportStatus, discover
from harness_cli.platforms import Platform
from harness_cli.receipts import ReceiptStore


PI_SKILL_PACKAGES = (
    "tdd",
    "resolving-merge-conflicts",
    "setup-git-worktree-maker",
    "audit",
    "grill-me",
    "breakdown-help-wanted-issue",
    "read-all-adrs",
    "writing-adrs",
    "writing-for-agents",
    "zoom-out",
    "prototype",
    "handoff",
    "handoff-grilling",
    "todo-hitl",
    "decisions",
    "next-decision",
    "stop-overthinking",
    "setup-command-aliases",
    "setup-text-replacements",
    "caveman",
    "setup-help",
)


@pytest.mark.parametrize("name", PI_SKILL_PACKAGES)
@pytest.mark.parametrize("scope", ("project", "user"))
def test_pi_skill_package_installs_independently_and_removes_owned_files(
    name, scope, tmp_path, monkeypatch
):
    available = discover()
    tool = available[name]
    assert tool.support_for(Platform.PI).status is SupportStatus.SUPPORTED
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(tmp_path / "custom-pi-agent"))
    # These packages declare external CLIs but have no installer host actions.
    monkeypatch.setattr("harness_cli.installer.shutil.which", lambda executable: executable)
    target = (
        Target.for_user(Platform.PI)
        if scope == "user"
        else Target.for_project(tmp_path / "project", Platform.PI)
    )
    assert target.install_root == (
        tmp_path / "custom-pi-agent" if scope == "user" else tmp_path / "project/.pi"
    )
    unrelated = target.install_root / "skills/personal/SKILL.md"
    unrelated.parent.mkdir(parents=True)
    unrelated.touch()
    settings = target.install_root / "settings.json"
    settings.write_text('{"theme":"personal-theme"}', encoding="utf-8")
    store = ReceiptStore.load(tmp_path / "receipts.json")
    installer = CatalogueInstaller(available, target, store)

    installer.reconcile({name})

    owned = installed_packages(target, store)
    assert set(owned) == {name}
    assert owned[name]["version"] == tool.version
    skill_names = (
        {"mark-as-todo-hitl", "address-todo-hitl"} if name == "todo-hitl" else {name}
    )
    assert {
        path.parent.name for path in (target.install_root / "skills").glob("*/SKILL.md")
    } == skill_names | {"personal"}
    payloads = tool.expand(Platform.PI, scope)
    assert all(payload.root == "skills" for payload in payloads)
    installed_paths = [target.destination_path(payload.root, payload.dest) for payload in payloads]
    assert all(path.is_file() for path in installed_paths)
    assert not list((target.install_root / "skills").rglob("openai.yaml"))
    expected_support = {
        "tdd": {"tests.md", "mocking.md"},
        "prototype": {"LOGIC.md", "UI.md"},
        "writing-for-agents": {"SKILL-MECHANICS.md"},
    }.get(name, set())
    assert {path.name for path in installed_paths if path.name != "SKILL.md"} == expected_support
    assert installer.reconcile({name}) == []

    # Removal uses the durable receipt, including both todo-hitl skill directories.
    reloaded = ReceiptStore.load(store.path)
    CatalogueInstaller(available, target, reloaded).reconcile(set())

    assert not installed_packages(target, reloaded)
    assert all(not path.exists() for path in installed_paths)
    assert unrelated.is_file()
    assert settings.read_text(encoding="utf-8") == '{"theme":"personal-theme"}'
