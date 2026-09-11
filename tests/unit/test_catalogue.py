import hashlib
import io
from contextlib import nullcontext

import pytest

from harness_cli.catalogue import CatalogueError, resolve_dependencies
from harness_cli import cli
from harness_cli.cli import build_parser
from harness_cli.installer import CatalogueInstaller, InstallError, Target
from harness_cli.host_actions import HostActionError, PreparedAction, prepare
from harness_cli.manifest import HostAction, ManifestError, discover, load_tool
from harness_cli.platforms import Platform
from harness_cli.receipts import ReceiptStore


def manager(tools, target, tmp_path):
    return CatalogueInstaller(tools, target, ReceiptStore.load(tmp_path / "receipts.json"))


def test_installer_cli_does_not_expose_runtime_commands():
    parser = build_parser()
    assert all(action.dest != "command" for action in parser._actions)


def test_catalogue_asks_for_tools_before_scope_and_defaults_to_both_platforms(monkeypatch):
    aboard = discover()["aboard"]
    questions = []
    planned = {}

    class InteractiveInput:
        @staticmethod
        def isatty():
            return True

    class FakeUI:
        def __init__(self, read_key):
            pass

        def checklist(self, title, options, selected):
            questions.append(title)
            return {0}

        def choose(self, title, options, default=0, note=""):
            questions.append(title)
            return 0

        def message(self, title, lines):
            questions.append(title)

    class FakeInstaller:
        def __init__(self, available, target, store):
            self.target = target

        def plan(self, requested):
            planned[self.target.platform] = requested
            return [], []

        def reconcile(self, requested):
            raise AssertionError("nothing should be reconciled when there are no changes")

    monkeypatch.setattr(cli.sys, "stdin", InteractiveInput())
    monkeypatch.setattr(cli, "discover", lambda: {aboard.name: aboard})
    monkeypatch.setattr(cli, "terminal_keys", lambda: nullcontext(lambda: ""))
    monkeypatch.setattr(cli, "TerminalUI", FakeUI)
    monkeypatch.setattr(cli, "CatalogueInstaller", FakeInstaller)
    monkeypatch.setattr(cli.ReceiptStore, "load", lambda: object())

    assert cli.catalogue_menu() == 0
    assert questions[:4] == [
        "Choose tools",
        "Where should Harness install them?",
        "Which agent platforms?",
        "Review installation",
    ]
    assert planned == {Platform.CLAUDE: {"aboard"}, Platform.CHATGPT: {"aboard"}}


def test_aboard_is_labelled_cross_platform():
    assert cli._compatibility(discover()["aboard"]) == "Claude + ChatGPT"


def test_dependencies_install_transitively_and_receipts_track_ownership(tmp_path):
    tools = discover()
    target = Target.for_project(tmp_path)
    selected = manager(tools, target, tmp_path)
    resolved, _ = selected.plan({"aboard"})
    receipts = {item.tool.name: item.explicit for item in resolved}
    assert receipts["aboard"] is True
    for dependency in ("auto", "issue-readers"):
        assert receipts[dependency] is False
    assert "adress-this" not in receipts
    assert "review-this" not in receipts


def test_dependency_cycle_is_rejected(tmp_path):
    def package(name, dependency):
        root = tmp_path / name
        root.mkdir()
        (root / "payload").write_text(name)
        (root / "harness.toml").write_text(
            f'name="{name}"\nversion="1.0.0"\ndescription="x"\n'
            f'dependencies=["{dependency}"]\n[platforms.claude]\nstatus="supported"\n'
            f'[[files]]\nsrc="payload"\ndest="{name}"\n'
        )
        return load_tool(root)

    tools = {"a": package("a", "b"), "b": package("b", "a")}
    with pytest.raises(CatalogueError, match="a -> b -> a"):
        resolve_dependencies([tools["a"]], tools)


def test_collision_is_detected_before_writing(tmp_path):
    def package(name):
        root = tmp_path / name
        root.mkdir()
        (root / "payload").write_text(name)
        (root / "harness.toml").write_text(
            f'name="{name}"\nversion="1.0.0"\ndescription="x"\n'
            '[platforms.claude]\nstatus="supported"\n'
            '[[files]]\nsrc="payload"\ndest="same.txt"\n'
        )
        return load_tool(root)

    tools = {name: package(name) for name in ("a", "b")}
    target = Target.for_project(tmp_path / "project")
    with pytest.raises(InstallError, match="file collision"):
        manager(tools, target, tmp_path).reconcile({"a", "b"})
    assert not target.install_root.exists()


def test_workspace_files_can_be_limited_to_project_installs(tmp_path):
    root = tmp_path / "scoped"
    root.mkdir()
    (root / "payload").write_text("starter")
    (root / "harness.toml").write_text(
        'name="scoped"\nversion="1.0.0"\ndescription="x"\n'
        '[platforms.claude]\nstatus="supported"\n'
        '[[files]]\nsrc="payload"\ndest=".harness/agent-launcher/config.py"\n'
        'root="workspace"\nscopes=["project"]\nstarter=true\n'
    )
    tool = load_tool(root)

    assert [item.dest for item in tool.expand("claude", "project")] == [
        ".harness/agent-launcher/config.py"
    ]
    assert tool.expand("claude", "user") == []


@pytest.mark.parametrize("scopes", ['"project"', '["machine"]', '[]'])
def test_manifest_rejects_invalid_file_scopes(tmp_path, scopes):
    root = tmp_path / "invalid-scopes"
    root.mkdir()
    (root / "payload").write_text("x")
    (root / "harness.toml").write_text(
        'name="invalid-scopes"\nversion="1.0.0"\ndescription="x"\n'
        '[platforms.claude]\nstatus="supported"\n'
        f'[[files]]\nsrc="payload"\ndest="payload"\nscopes={scopes}\n'
    )

    with pytest.raises(ManifestError, match="files.scopes"):
        load_tool(root)


def test_manifest_rejects_uv_tool_source_without_full_commit_sha(tmp_path):
    root = tmp_path / "mutable-uv-tool-source"
    root.mkdir()
    (root / "harness.toml").write_text(
        'name="mutable-uv-tool-source"\nversion="1.0.0"\ndescription="x"\n'
        '[platforms.claude]\nstatus="supported"\n'
        '[[actions]]\ntype="uv-tool"\npackage="example"\n'
        'source="git+https://example.test/harness@v1.0.0"\n'
    )

    with pytest.raises(ManifestError, match="full commit SHA"):
        load_tool(root)


def test_receipt_driven_uninstall_keeps_modified_files(tmp_path):
    tool = discover()["caveman"]
    target = Target.for_project(tmp_path / "project")
    selected = manager({tool.name: tool}, target, tmp_path)
    selected.reconcile({tool.name})
    skill = target.install_root / "skills/caveman/SKILL.md"
    skill.write_text("mine")
    selected.reconcile(set())
    assert skill.read_text() == "mine"
    assert selected.installation["packages"] == {}


def transactional_package(tmp_path, name, *, action=False):
    root = tmp_path / name
    root.mkdir()
    (root / "payload").write_text(name)
    (root / "fragment.json").write_text('{"env": {"PACKAGE": "installed"}}')
    manifest = (
        f'name="{name}"\nversion="1.0.0"\ndescription="x"\n'
        'gitignore=["generated"]\n'
        '[platforms.claude]\nstatus="supported"\nfragment="fragment.json"\n'
        f'[[files]]\nsrc="payload"\ndest="{name}.txt"\n'
    )
    if action:
        manifest += (
            '[[actions]]\ntype="uv-tool"\n'
            'source="git+https://example.test/harness@0123456789abcdef0123456789abcdef01234567"\n'
            f'package="{name}-test"\n'
        )
    (root / "harness.toml").write_text(manifest)
    return load_tool(root)


def test_failed_host_action_rolls_back_local_installation(monkeypatch, tmp_path):
    tool = transactional_package(tmp_path, "failing", action=True)
    project = tmp_path / "project"
    project.mkdir()
    (project / ".gitignore").write_text("existing\n")
    target = Target.for_project(project)
    selected = manager({tool.name: tool}, target, tmp_path)

    monkeypatch.setattr(
        "harness_cli.installer.prepare_host_action",
        lambda action: PreparedAction(action),
    )
    monkeypatch.setattr("harness_cli.installer.host_action_is_installed", lambda action: False)
    monkeypatch.setattr(
        "harness_cli.installer.apply_host_action",
        lambda action: (_ for _ in ()).throw(HostActionError("host failed")),
    )

    with pytest.raises(InstallError, match="host failed"):
        selected.reconcile({tool.name})

    assert (project / ".gitignore").read_text() == "existing\n"
    assert not target.settings_path.exists()
    assert not (target.install_root / "failing.txt").exists()
    assert selected.installation["packages"] == {}
    assert not selected.store.path.exists()


def test_receipt_failure_undoes_completed_host_action(monkeypatch, tmp_path):
    tool = transactional_package(tmp_path, "failing", action=True)
    target = Target.for_project(tmp_path / "project")
    selected = manager({tool.name: tool}, target, tmp_path)
    applied = []
    removed = []

    monkeypatch.setattr(
        "harness_cli.installer.prepare_host_action",
        lambda action: PreparedAction(action),
    )
    monkeypatch.setattr("harness_cli.installer.host_action_is_installed", lambda action: False)
    monkeypatch.setattr("harness_cli.installer.apply_host_action", lambda prepared: applied.append(prepared.action))
    monkeypatch.setattr("harness_cli.installer.uninstall_host_action", removed.append)
    monkeypatch.setattr(
        selected.store,
        "save",
        lambda: (_ for _ in ()).throw(OSError("receipt failed")),
    )

    with pytest.raises(InstallError, match="receipt failed"):
        selected.reconcile({tool.name})

    assert removed == applied
    assert not (target.install_root / "failing.txt").exists()
    assert selected.installation["packages"] == {}


def test_failed_upgrade_restores_previous_files_receipt_and_host_action(monkeypatch, tmp_path):
    old = transactional_package(tmp_path, "upgrade", action=True)
    target = Target.for_project(tmp_path / "project")
    selected = manager({old.name: old}, target, tmp_path)
    applied = []
    removed = []

    monkeypatch.setattr(
        "harness_cli.installer.prepare_host_action",
        lambda action: PreparedAction(action),
    )
    monkeypatch.setattr("harness_cli.installer.host_action_is_installed", lambda action: False)
    monkeypatch.setattr("harness_cli.installer.apply_host_action", lambda prepared: applied.append(prepared.action))
    monkeypatch.setattr("harness_cli.installer.uninstall_host_action", removed.append)
    selected.reconcile({old.name})
    applied.clear()

    old.root.joinpath("payload").write_text("new")
    manifest = old.root / "harness.toml"
    manifest.write_text(manifest.read_text().replace('version="1.0.0"', 'version="2.0.0"'))
    upgraded = load_tool(old.root)
    selected.available = {upgraded.name: upgraded}
    monkeypatch.setattr(
        selected.store,
        "save",
        lambda: (_ for _ in ()).throw(OSError("receipt failed")),
    )

    with pytest.raises(InstallError, match="receipt failed"):
        selected.reconcile({upgraded.name})

    assert (target.install_root / "upgrade.txt").read_text() == "upgrade"
    assert selected.installation["packages"][old.name]["version"] == "1.0.0"
    assert len(applied) == 2
    assert removed == [upgraded.actions[0]]


def test_later_failure_restores_package_removed_earlier_in_reconciliation(monkeypatch, tmp_path):
    old = transactional_package(tmp_path, "old", action=True)
    failing = transactional_package(tmp_path, "failing", action=True)
    target = Target.for_project(tmp_path / "project")
    selected = manager({old.name: old, failing.name: failing}, target, tmp_path)
    applied = []
    removed = []
    fail_host_action = {"enabled": False}

    def apply(prepared):
        if fail_host_action["enabled"] and prepared.action == failing.actions[0]:
            raise HostActionError("host failed")
        applied.append(prepared.action)

    monkeypatch.setattr(
        "harness_cli.installer.prepare_host_action",
        lambda action: PreparedAction(action),
    )
    monkeypatch.setattr("harness_cli.installer.host_action_is_installed", lambda action: False)
    monkeypatch.setattr("harness_cli.installer.apply_host_action", apply)
    monkeypatch.setattr("harness_cli.installer.uninstall_host_action", removed.append)
    selected.reconcile({old.name})
    applied.clear()
    payload = target.install_root / "old.txt"
    before = payload.read_bytes()
    fail_host_action["enabled"] = True

    with pytest.raises(InstallError, match="host failed"):
        selected.reconcile({failing.name})

    assert payload.read_bytes() == before
    assert set(selected.installation["packages"]) == {old.name}
    assert removed == [old.actions[0]]
    assert applied == [old.actions[0]]


def test_every_catalogue_manifest_loads():
    tools = discover()
    assert {"aboard", "subagents", "issue-readers", "issue-writers"} <= tools.keys()
    assert {
        "adress-this", "review-this", "harness-cli", "communication-hooks",
        "improve-codebase-architecture", "senior-advisor",
    }.isdisjoint(tools)
    expected_categories = {
        "planning": {"audit", "breakdown-help-wanted-issue", "grill-me", "prototype", "websearch"},
        "building": {"issue-readers", "issue-writers", "tdd"},
        "shipping": {"commit"},
        "productivity": {
            "agent-launcher", "caveman", "command-aliases", "handoff", "report-gotchas", "subagents",
            "setup-git-worktree-maker", "text-replacements", "todo-hitl", "writing-for-agents",
            "zoom-out",
        },
        "guards": {
            "command-guard", "no-new-documents", "on-edit-block", "on-edit-reminder", "on-read-reminder",
            "prefer-edit-tool", "prefer-fewer-comments", "prefer-read-tool",
            "redirect-subagents", "usage-limit-wait",
        },
        "extension": {"aboard", "auto"},
    }
    actual_categories = {}
    catalogue_root = next(parent for parent in tools["aboard"].root.parents if parent.name == "harness")
    for name, tool in tools.items():
        category = tool.root.relative_to(catalogue_root).parts[0]
        actual_categories.setdefault(category, set()).add(name)
    assert actual_categories == expected_categories


def test_vsix_is_verified_before_host_install(monkeypatch):
    content = b"signed release artifact"
    monkeypatch.setattr("urllib.request.urlopen", lambda *args, **kwargs: io.BytesIO(content))
    action = HostAction(
        "vscode-extension",
        {
            "url": "https://example.test/download/v1/app.vsix",
            "size": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
            "extension_id": "example.app",
        },
    )
    prepared = prepare(action)
    try:
        assert prepared.artifact.read_bytes() == content
    finally:
        prepared.cleanup()

    broken = HostAction("vscode-extension", {**action.data, "sha256": "0" * 64})
    with pytest.raises(HostActionError, match="SHA-256"):
        prepare(broken)
