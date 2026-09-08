import hashlib
import io

import pytest

from harness_cli.catalogue import CatalogueError, resolve_dependencies
from harness_cli.cli import build_parser
from harness_cli.installer import CatalogueInstaller, InstallError, Target
from harness_cli.host_actions import HostActionError, prepare
from harness_cli.manifest import HostAction, discover, load_tool
from harness_cli.receipts import ReceiptStore


def manager(tools, target, tmp_path):
    return CatalogueInstaller(tools, target, ReceiptStore.load(tmp_path / "receipts.json"))


def test_cli_has_only_session_commands():
    parser = build_parser()
    choices = next(action for action in parser._actions if action.dest == "command").choices
    assert set(choices) == {"run", "ask", "reply", "resume"}


def test_dependencies_install_transitively_and_receipts_track_ownership(tmp_path):
    tools = discover()
    target = Target.for_project(tmp_path)
    selected = manager(tools, target, tmp_path)
    resolved, _ = selected.plan({"aboard"})
    receipts = {item.tool.name: item.explicit for item in resolved}
    assert receipts["aboard"] is True
    for dependency in ("auto", "implement", "review-afk", "review-hitl"):
        assert receipts[dependency] is False


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


def test_every_catalogue_manifest_loads():
    tools = discover()
    assert {"aboard", "harness-cli", "implement", "review-afk", "review-hitl"} <= tools.keys()


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
