"""Pinned npm host tools use the catalogue's existing ownership and rollback lifecycle."""

import hashlib
import json
import subprocess
from dataclasses import replace
from pathlib import Path

import pytest

from harness_cli import host_actions
from harness_cli.host_actions import HostActionError
from harness_cli.installer import CatalogueInstaller, InstallError, Target, UnownedHostProductError
from harness_cli.manifest import HostAction, ManifestError, discover, load_tool
from harness_cli.platforms import Platform
from harness_cli.receipts import ReceiptStore


@pytest.fixture
def npm(monkeypatch):
    host_actions.forget_host_products()
    installed = {}
    commands = []
    monkeypatch.setattr(host_actions, "_npm_command", lambda: ["node", "npm-cli.js"])

    def run(command, **kwargs):
        assert kwargs.get("shell", False) is False
        commands.append(command)
        if command[2] == "list":
            output = json.dumps({"dependencies": {name: {"version": version} for name, version in installed.items()}})
        else:
            package = command[-1]
            if command[2] == "install":
                name, version = package.rsplit("@", 1)
                installed[name] = version
            else:
                installed.pop(package, None)
            output = ""
        return subprocess.CompletedProcess(command, 0, output, "")

    monkeypatch.setattr(host_actions.subprocess, "run", run)
    monkeypatch.setattr("harness_cli.installer.shutil.which", lambda name: name)
    yield installed, commands
    host_actions.forget_host_products()


def test_npm_actions_install_exact_version_share_inventory_and_remove(npm):
    installed, commands = npm
    action = HostAction("npm-tool", {"package": "@example/browser", "version": "1.2.3"})
    assert not host_actions.is_installed(action)
    assert not host_actions.is_installed(action)
    assert len(commands) == 1
    prepared = host_actions.prepare(action)
    host_actions.apply(prepared)
    assert installed == {"@example/browser": "1.2.3"}
    assert commands[-1] == ["node", "npm-cli.js", "install", "--global", "--engine-strict", "--no-audit", "--no-fund", "@example/browser@1.2.3"]
    assert host_actions.is_installed(action)
    host_actions.uninstall(action)
    assert installed == {}
    assert not host_actions.is_installed(action)


@pytest.mark.parametrize("code,stdout", [(1, "failure"), (0, "not json"), (0, "[]"), (0, '{"dependencies": []}')])
def test_npm_inventory_failure_does_not_assume_package_absent(monkeypatch, code, stdout):
    host_actions.forget_host_products()
    monkeypatch.setattr(host_actions, "_npm_command", lambda: ["npm"])
    monkeypatch.setattr(host_actions.subprocess, "run", lambda command, **kwargs: subprocess.CompletedProcess(command, code, stdout, ""))
    with pytest.raises(HostActionError):
        host_actions.is_installed(HostAction("npm-tool", {"package": "browser"}))
    host_actions.forget_host_products()


def test_windows_npm_launcher_runs_node_directly(tmp_path, monkeypatch):
    directory = tmp_path / "Node with spaces & symbols"
    cli = directory / "node_modules/npm/bin/npm-cli.js"
    cli.parent.mkdir(parents=True)
    cli.touch()
    monkeypatch.setattr(host_actions.shutil, "which", lambda name: str(directory / ("npm.cmd" if name == "npm" else "node.exe")))
    assert host_actions._npm_command() == [str(directory / "node.exe"), str(cli)]


def test_missing_npm_fails_before_install(monkeypatch):
    monkeypatch.setattr(host_actions.shutil, "which", lambda name: None)
    with pytest.raises(HostActionError, match="npm on PATH"):
        host_actions.prepare(HostAction("npm-tool", {"package": "browser", "version": "1.2.3"}))


def test_npm_inventory_recognizes_a_prefix_without_a_first_install(tmp_path, monkeypatch):
    monkeypatch.setattr(host_actions, "_npm_command", lambda: ["npm"])

    def run(command, **kwargs):
        if command[1] == "list":
            return subprocess.CompletedProcess(command, 1, '{"error":{"code":"ENOENT"}}', "")
        return subprocess.CompletedProcess(command, 0, str(tmp_path / "prefix/node_modules") + "\n", "")

    monkeypatch.setattr(host_actions.subprocess, "run", run)
    assert not host_actions.is_installed(HostAction("npm-tool", {"package": "browser"}))


@pytest.mark.parametrize("package,version", [
    ("browser", "latest"), ("browser", "^1.2.3"), ("browser", "1.2"),
    ("browser", "01.2.3"), ("browser", "1.2.3 --force"),
    ("--force", "1.2.3"), ("https://example.test/tool.tgz", "1.2.3"),
    ("../browser", "1.2.3"), ("browser@latest", "1.2.3"),
])
def test_manifest_rejects_mutable_or_non_registry_npm_sources(tmp_path, package, version):
    (tmp_path / "harness.toml").write_text(
        'name="browser"\nversion="1.0.0"\ndescription="x"\n'
        '[platforms.pi]\nstatus="supported"\n'
        f'[[actions]]\ntype="npm-tool"\npackage="{package}"\nversion="{version}"\n', encoding="utf-8",
    )
    with pytest.raises(ManifestError, match="npm-tool"):
        load_tool(tmp_path)


@pytest.mark.parametrize("platform", list(Platform))
@pytest.mark.parametrize("scope", ["project", "user"])
def test_chrome_devtools_installs_shared_skill_and_receipt_driven_removal(tmp_path, monkeypatch, npm, platform, scope):
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(tmp_path / "pi-agent"))
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "home")
    target = Target.for_project(tmp_path / "project", platform) if scope == "project" else Target.for_user(platform)
    store = ReceiptStore.load(tmp_path / "receipts.json")
    installer = CatalogueInstaller(discover(), target, store)
    installed, commands = npm
    installer.plan({"chrome-devtools"})
    assert installed == {}
    installer.reconcile({"chrome-devtools"})
    skill = target.destination_path("skills", "chrome-devtools-cli/SKILL.md")
    assert skill.is_file()
    assert (skill.parent / "references/installation.md").is_file()
    assert (skill.parent / "LICENSE").is_file()
    assert (skill.parent / "agents/openai.yaml").exists() == (platform is Platform.CHATGPT)
    assert not target.settings_path.exists()
    assert installed == {"chrome-devtools-mcp": "1.11.0"}
    installs = len([cmd for cmd in commands if cmd[2] == "install"])
    assert installer.reconcile({"chrome-devtools"}) == []
    assert len([cmd for cmd in commands if cmd[2] == "install"]) == installs
    reloaded = CatalogueInstaller(discover(), target, ReceiptStore.load(tmp_path / "receipts.json"))
    reloaded.reconcile(set())
    assert installed == {}
    assert not skill.exists()


def test_preexisting_npm_installation_is_protected(tmp_path, npm):
    installed, commands = npm
    installed["chrome-devtools-mcp"] = "9.0.0"
    target = Target.for_project(tmp_path / "project", Platform.PI)
    installer = CatalogueInstaller(discover(), target, ReceiptStore.load(tmp_path / "receipts.json"))
    with pytest.raises(UnownedHostProductError):
        installer.reconcile({"chrome-devtools"})
    assert installed == {"chrome-devtools-mcp": "9.0.0"}
    assert all(cmd[2] == "list" for cmd in commands)
    assert not target.destination_path("skills", "chrome-devtools-cli/SKILL.md").exists()


def test_npm_host_tool_is_shared_across_provider_receipts(tmp_path, npm):
    store = ReceiptStore.load(tmp_path / "receipts.json")
    tools = discover()
    pi = CatalogueInstaller(tools, Target.for_project(tmp_path / "project", Platform.PI), store)
    claude = CatalogueInstaller(tools, Target.for_project(tmp_path / "project", Platform.CLAUDE), store)
    pi.reconcile({"chrome-devtools"})
    claude.reconcile({"chrome-devtools"})
    pi.reconcile(set())
    assert npm[0] == {"chrome-devtools-mcp": "1.11.0"}
    claude.reconcile(set())
    assert npm[0] == {}
    assert len([cmd for cmd in npm[1] if cmd[2] == "install"]) == 1


def test_npm_upgrade_failure_restores_skill_and_old_version(tmp_path, monkeypatch, npm):
    tool = discover()["chrome-devtools"]
    target = Target.for_project(tmp_path / "project", Platform.PI)
    store = ReceiptStore.load(tmp_path / "receipts.json")
    installer = CatalogueInstaller({tool.name: tool}, target, store)
    installer.reconcile({tool.name})
    upgraded = replace(tool, version="1.1.0", actions=(HostAction("npm-tool", {"package": "chrome-devtools-mcp", "version": "1.12.0"}),))
    failing = replace(tool, name="zzz-failure", files=(), actions=(HostAction("npm-tool", {"package": "zzz-failure", "version": "1.0.0"}),))
    apply = host_actions.apply

    def fail(prepared):
        if prepared.action.data["package"] == "zzz-failure":
            raise HostActionError("registry unavailable")
        apply(prepared)

    monkeypatch.setattr("harness_cli.installer.apply_host_action", fail)
    with pytest.raises(InstallError, match="registry unavailable"):
        CatalogueInstaller({tool.name: upgraded, failing.name: failing}, target, store).reconcile({tool.name, failing.name})
    assert npm[0] == {"chrome-devtools-mcp": "1.11.0"}
    assert any(cmd[-1] == "chrome-devtools-mcp@1.12.0" for cmd in npm[1])
    assert target.destination_path("skills", "chrome-devtools-cli/SKILL.md").is_file()
    assert store.data == ReceiptStore.load(tmp_path / "receipts.json").data


def test_vendored_chrome_files_match_recorded_upstream_hashes():
    tool = discover()["chrome-devtools"]
    upstream = json.loads((tool.root / "UPSTREAM.json").read_text(encoding="utf-8"))
    assert upstream["version"] == tool.actions[0].data["version"]
    for name, record in upstream["files"].items():
        assert hashlib.sha256((tool.root / name).read_bytes()).hexdigest() == record["sha256"]
