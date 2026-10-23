"""Upstream bridges acquire native payloads and retain normal file ownership."""

import hashlib
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from harness_cli.installer import CatalogueInstaller, InstallError, Target, installed_packages
from harness_cli.manifest import FileSpec, ManifestError, discover, load_tool
from harness_cli.platforms import Platform
from harness_cli.receipts import ReceiptStore


@pytest.fixture
def upstream(tmp_path, monkeypatch):
    state = {"calls": [], "payload": b"upstream revision one\n", "fail": False}
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(tmp_path / "pi-agent"))
    monkeypatch.setattr("harness_cli.installer.shutil.which", lambda command: command)
    monkeypatch.setattr("harness_cli.upstream_skills._npm_command", lambda: ["npm"])

    def run(command, **kwargs):
        state["calls"].append(command)
        assert command == [
            "npm", "exec", "--yes", "--package=skills", "--", "skills", "add",
            "kunchenguid/lavish-axi", "--skill", "lavish", "--agent", "claude-code", "--copy", "--yes",
        ]
        if state["fail"]:
            return SimpleNamespace(returncode=1, stderr="upstream unavailable", stdout="")
        root = Path(kwargs["cwd"]) / ".claude/skills/lavish"
        root.mkdir(parents=True)
        (root / "SKILL.md").write_bytes(state["payload"])
        support = root / "references" / "example.bin"
        support.parent.mkdir()
        support.write_bytes(bytes(range(256)))
        return SimpleNamespace(returncode=0, stderr="", stdout="")

    monkeypatch.setattr("harness_cli.upstream_skills.subprocess.run", run)
    return state


@pytest.mark.parametrize("platform", tuple(Platform))
@pytest.mark.parametrize("scope", ("project", "user"))
def test_upstream_bridge_lifecycle(platform, scope, tmp_path, monkeypatch, upstream):
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "home")
    target = Target.for_user(platform) if scope == "user" else Target.for_project(tmp_path / "project", platform)
    store = ReceiptStore.load(tmp_path / "receipts.json")
    available = discover()
    assert not available["lavish"].files
    installer = CatalogueInstaller(available, target, store)
    installer.reconcile({"lavish"})
    installed = target.destination_path("skills", "lavish/SKILL.md")
    expected_digest = hashlib.sha256(upstream["payload"]).hexdigest()
    assert hashlib.sha256(installed.read_bytes()).hexdigest() == expected_digest
    support = installed.parent / "references/example.bin"
    assert hashlib.sha256(support.read_bytes()).hexdigest() == hashlib.sha256(bytes(range(256))).hexdigest()
    receipt = installed_packages(target, store)["lavish"]
    assert receipt["version"].startswith("1.2.0+")
    assert receipt["actions"] == []
    assert len(receipt["files"]) == 2
    assert installer.reconcile({"lavish"}) == []
    assert len(upstream["calls"]) == 1
    assert not installed.parent.joinpath("agents/openai.yaml").exists()

    # Removal works offline with just the durable receipts.
    upstream["fail"] = True
    CatalogueInstaller(available, target, ReceiptStore.load(store.path)).reconcile(set())
    assert not installed.exists()
    assert not support.exists()
    assert len(upstream["calls"]) == 1


def test_explicit_upgrade_follows_upstream_but_preserved_install_does_not(tmp_path, upstream):
    available = discover()
    target = Target.for_project(tmp_path / "project", Platform.CHATGPT)
    store = ReceiptStore.load(tmp_path / "receipts.json")
    CatalogueInstaller(available, target, store).reconcile({"lavish"})
    old_version = installed_packages(target, store)["lavish"]["version"]
    upstream["payload"] = b"upstream revision two\n"
    preserved = CatalogueInstaller(available, target, store)
    preserved.update_packages = set()
    assert preserved.reconcile({"lavish"}) == []
    assert len(upstream["calls"]) == 1
    changes = CatalogueInstaller(available, target, store).reconcile({"lavish"})
    assert [change.action for change in changes] == ["upgrade"]
    assert installed_packages(target, store)["lavish"]["version"] != old_version


def test_upgrade_replaces_old_vendored_skill_and_removes_metadata(tmp_path, upstream):
    tool = discover()["lavish"]
    source = tmp_path / "old"
    source.mkdir()
    (source / "SKILL.md").write_bytes(b"old vendored payload")
    (source / "openai.yaml").write_bytes(b"old local metadata")
    old = replace(tool, root=source, version="1.1.0", actions=(), files=(
        FileSpec("SKILL.md", "lavish/SKILL.md", "skills"),
        FileSpec("openai.yaml", "lavish/agents/openai.yaml", "skills"),
    ))
    target = Target.for_project(tmp_path / "project", Platform.CHATGPT)
    store = ReceiptStore.load(tmp_path / "receipts.json")
    CatalogueInstaller({"lavish": old}, target, store).reconcile({"lavish"})
    CatalogueInstaller({"lavish": tool}, target, store).reconcile({"lavish"})
    assert not target.destination_path("skills", "lavish/agents/openai.yaml").exists()
    installed = target.destination_path("skills", "lavish/SKILL.md")
    assert hashlib.sha256(installed.read_bytes()).digest() == hashlib.sha256(upstream["payload"]).digest()


def test_failed_upstream_upgrade_preserves_installation_and_receipt(tmp_path, upstream):
    available = discover()
    target = Target.for_project(tmp_path / "project", Platform.PI)
    store = ReceiptStore.load(tmp_path / "receipts.json")
    CatalogueInstaller(available, target, store).reconcile({"lavish"})
    receipt = store.path.read_bytes()
    installed = target.destination_path("skills", "lavish/SKILL.md")
    digest = hashlib.sha256(installed.read_bytes()).digest()
    upstream["fail"] = True
    with pytest.raises(InstallError, match="upstream unavailable"):
        CatalogueInstaller(available, target, store).reconcile({"lavish"})
    assert store.path.read_bytes() == receipt
    assert hashlib.sha256(installed.read_bytes()).digest() == digest


def test_upstream_bridge_supports_shared_claude_skill_links(tmp_path, upstream):
    target = Target.for_project(tmp_path / "project", Platform.CLAUDE)
    store = ReceiptStore.load(tmp_path / "receipts.json")
    installer = CatalogueInstaller(discover(), target, store, skill_mode="symlink")
    installer.reconcile({"lavish"})
    link = target.scope_root / ".claude/skills/lavish"
    shared = target.scope_root / ".agents/skills/lavish"
    assert link.is_symlink()
    assert link.resolve() == shared.resolve()
    # Recover the existing mode from the receipt and remove both owned paths.
    reloaded = CatalogueInstaller(discover(), target, ReceiptStore.load(store.path))
    assert reloaded.skill_mode == "symlink"
    reloaded.reconcile(set())
    assert not link.is_symlink()
    assert not shared.exists()


@pytest.mark.parametrize("source,skill", [("-bad", "lavish"), ("owner/repo", "../escape"), ("owner/repo", "--all")])
def test_invalid_upstream_action_rejected(tmp_path, source, skill):
    (tmp_path / "harness.toml").write_text(
        'name="test"\nversion="1.0.0"\ndescription="bridge"\n'
        '[platforms.claude]\nstatus="supported"\n'
        f'[[actions]]\ntype="upstream-skill"\nsource="{source}"\nskill="{skill}"\n',
        encoding="utf-8",
    )
    with pytest.raises(ManifestError, match="upstream-skill"):
        load_tool(tmp_path)
