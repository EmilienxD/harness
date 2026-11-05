import json
import re
import shlex
import subprocess
import zipfile
from pathlib import Path

import pytest

from harness_cli import host_actions
from harness_cli.cli import main
from harness_cli.installer import CatalogueInstaller, Target
from harness_cli.manifest import ManifestError, discover
from harness_cli.receipts import ReceiptStore


CHECKOUT = Path(__file__).resolve().parents[2]


@pytest.fixture
def local_extension(tmp_path):
    checkout = tmp_path / "checkout with spaces"
    source = checkout / "apps/aboard"
    source.mkdir(parents=True)
    (source / "src").mkdir()
    (source / "src/extension.ts").write_text("export const revision = 1;", encoding="utf-8")
    (source / "package.json").write_text(json.dumps({
        "publisher": "aboard", "name": "aboard", "version": "0.3.15",
    }), encoding="utf-8")
    manifest = checkout / "harness/vscode/aboard/harness.toml"
    manifest.parent.mkdir(parents=True)
    manifest.write_text('''name = "aboard"
version = "0.0.9"
description = "local extension fixture"
[platforms.claude]
status = "supported"
[platforms.chatgpt]
status = "supported"
[[actions]]
type = "vscode-extension"
extension_id = "aboard.aboard"
local_source = "apps/aboard"
url = "https://example.test/releases/download/v0.3.13/aboard-0.3.13.vsix"
size = 1
sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
''', encoding="utf-8")
    return checkout, source


def write_vsix(source, version="0.3.15"):
    artifact = source / "dist/aboard-0.3.15.vsix"
    artifact.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(artifact, "w") as archive:
        archive.writestr("extension/package.json", json.dumps({
            "publisher": "aboard", "name": "aboard", "version": version,
        }))
        archive.writestr("extension/dist/extension.js", b"local build")
    return artifact


def test_every_catalogue_tool_uses_checkout_payloads_and_owned_runtimes():
    published = discover()
    local = discover(local=CHECKOUT)
    assert local.keys() == published.keys()
    for name, tool in local.items():
        assert tool.root == CHECKOUT / published[name].root.relative_to(CHECKOUT)
        for original, action in zip(published[name].actions, tool.actions, strict=True):
            if action.type == "uv-tool":
                assert Path(action.data["source"]).is_relative_to(CHECKOUT)
                assert (Path(action.data["source"]) / "pyproject.toml").is_file()
            elif action.type == "vscode-extension":
                assert action.data["source"] == str(CHECKOUT / "apps/aboard")
                assert action.data["version"] == json.loads((CHECKOUT / "apps/aboard/package.json").read_text())["version"]
                assert "url" not in action.data
            else:
                assert action == original
        for platform in ("claude", "chatgpt", "pi"):
            for scope in ("project", "user"):
                for payload in tool.expand(platform, scope):
                    assert payload.source.is_relative_to(CHECKOUT) or (
                        tool.local_payloads and payload.source in tool.local_payloads.sources.values()
                    )


@pytest.mark.parametrize("difference", ["missing", "different-version", "same-version", "changed-source", "different-checkout"])
def test_local_extension_plan_tracks_checkout_version_and_build_inputs(local_extension, tmp_path, monkeypatch, difference):
    checkout, source = local_extension
    tool = discover(local=checkout)["aboard"]
    target = Target.for_project(tmp_path / "project", "claude")
    store = ReceiptStore.load(tmp_path / "receipts.json")
    receipt_action = {"type": tool.actions[0].type, **tool.actions[0].data}
    target.installation(store, create=True)["packages"]["aboard"] = {
        "version": tool.version, "ownership": "selected", "actions": [receipt_action],
    }
    if difference == "changed-source":
        (source / "src/extension.ts").write_text("export const revision = 2;", encoding="utf-8")
        tool = discover(local=checkout)["aboard"]
    elif difference == "different-checkout":
        receipt_action["source"] = str(tmp_path / "other checkout")
    monkeypatch.setattr(host_actions, "_vscode_executable", lambda: "code")
    version = "0.3.13" if difference == "different-version" else "0.3.15"
    monkeypatch.setattr(host_actions, "_listing", lambda command: (
        [] if difference == "missing" else [f"aboard.aboard@{version}" if "--show-versions" in command else "aboard.aboard"]
    ))
    _, changes = CatalogueInstaller({tool.name: tool}, target, store).plan({tool.name})
    assert bool(changes) is (difference != "same-version")


def test_local_extension_rebuilds_once_across_providers_and_tracks_source_reverts(local_extension, tmp_path, monkeypatch):
    checkout, source = local_extension
    store = ReceiptStore.load(tmp_path / "receipts.json")
    installed = []
    monkeypatch.setattr("harness_cli.installer.host_action_is_installed", lambda action: True)
    monkeypatch.setattr("harness_cli.installer.host_action_is_current", lambda action: True)
    monkeypatch.setattr("harness_cli.installer.prepare_host_action", host_actions.PreparedAction)
    monkeypatch.setattr("harness_cli.installer.apply_host_action", lambda prepared: installed.append(prepared.action))
    initial = discover(local=checkout)["aboard"]
    for platform in ("claude", "chatgpt"):
        target = Target.for_project(tmp_path / "project", platform)
        CatalogueInstaller({initial.name: initial}, target, store).reconcile({initial.name}, adopt={initial.name})
    assert len(installed) == 1
    (source / "src/extension.ts").write_text("export const revision = 2;", encoding="utf-8")
    changed = discover(local=checkout)["aboard"]
    for tool in (changed, initial):
        if tool is initial:
            (source / "src/extension.ts").write_text("export const revision = 1;", encoding="utf-8")
        for platform in ("claude", "chatgpt"):
            target = Target.for_project(tmp_path / "project", platform)
            CatalogueInstaller({tool.name: tool}, target, store).reconcile({tool.name})
    assert len(installed) == 3
    assert installed[-1] == initial.actions[0]
    for installation in store.data["installations"].values():
        assert installation["packages"]["aboard"]["actions"][0]["fingerprint"] == initial.actions[0].data["fingerprint"]


def test_local_extension_install_builds_the_checkout_and_never_downloads(local_extension, tmp_path, monkeypatch, capsys):
    checkout, source = local_extension
    (tmp_path / "project").mkdir()
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(host_actions, "_npm_command", lambda: ["node", "npm-cli.js"])
    monkeypatch.setattr(host_actions, "_vscode_executable", lambda: "code")
    monkeypatch.setattr(host_actions.urllib.request, "urlopen", lambda *_a, **_k: pytest.fail("local install downloaded a release"))
    commands = []
    installed = []

    def run(command, **kwargs):
        commands.append(command)
        if command[:2] == ["node", "npm-cli.js"]:
            assert kwargs["cwd"] == source
            if command[2:] == ["run", "package"]:
                write_vsix(source)
        if "--install-extension" in command:
            with zipfile.ZipFile(command[2]) as archive:
                installed.append(json.loads(archive.read("extension/package.json"))["version"])
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr(host_actions.subprocess, "run", run)
    assert main(["--local", str(checkout), "install", "aboard", "--root", str(tmp_path / "project"), "--platform", "claude", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["ok"] is True
    assert installed == ["0.3.15"]
    assert ["node", "npm-cli.js", "ci", "--no-audit", "--no-fund"] in commands
    assert (source / "dist/aboard-0.3.15.vsix").is_file()
    install = next(command for command in commands if "--install-extension" in command)
    assert not Path(install[2]).exists()


@pytest.mark.parametrize("failure", ["build", "wrong-artifact"])
def test_local_extension_failure_never_falls_back_to_release(local_extension, monkeypatch, failure):
    checkout, source = local_extension
    action = discover(local=checkout)["aboard"].actions[0]
    monkeypatch.setattr(host_actions, "_npm_command", lambda: ["npm"])
    monkeypatch.setattr(host_actions.urllib.request, "urlopen", lambda *_a, **_k: pytest.fail("release fallback"))

    def run(command, **kwargs):
        if failure == "wrong-artifact":
            write_vsix(source, version="0.3.13")
        return subprocess.CompletedProcess(command, 1 if failure == "build" else 0, stdout="", stderr="build failed")

    monkeypatch.setattr(host_actions.subprocess, "run", run)
    with pytest.raises(host_actions.HostActionError, match="build failed|identity/version"):
        host_actions.prepare(action)


def test_local_extension_dry_run_never_builds(local_extension, tmp_path, monkeypatch, capsys):
    checkout, source = local_extension
    (tmp_path / "project").mkdir()
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(host_actions, "_vscode_executable", lambda: None)
    monkeypatch.setattr("harness_cli.installer.prepare_host_action", lambda *_: pytest.fail("dry run built an extension"))
    assert main(["--local", str(checkout), "install", "aboard", "--root", str(tmp_path / "project"), "--platform", "claude", "--dry-run", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["dryRun"] is True
    assert not (source / "dist").exists()


@pytest.mark.parametrize("platform", ["claude", "chatgpt", "pi"])
def test_local_web_toolkit_installs_a_command_using_the_checkout(tmp_path, platform):
    tool = discover(local=CHECKOUT)["web-toolkit"]
    target = Target.for_project(tmp_path / platform, platform)
    store = ReceiptStore.load(tmp_path / "receipts.json")
    CatalogueInstaller({tool.name: tool}, target, store).reconcile({tool.name})
    skill = target.destination_path("skills", "web-toolkit/SKILL.md").read_text(encoding="utf-8")
    command = shlex.split(re.search(r"`(uvx [^`]+)`", skill)[1])
    source = command[command.index("--from") + 1]
    assert source == (CHECKOUT / "harness/productivity/web-toolkit/runtime").as_uri()
    assert command[-1] == "web-toolkit"
    assert tool.version != discover()["web-toolkit"].version


def test_local_native_web_toolkit_installs_the_checkout_runtime_and_can_return_to_the_pin(tmp_path):
    target = Target.for_project(tmp_path / "project", "pi")
    store = ReceiptStore.load(tmp_path / "receipts.json")
    extension = target.install_root / "npm/node_modules/harness-pi-web-toolkit-native/extensions/.harness-web-toolkit/index.ts"
    published = discover()["web-toolkit-native"]
    local = discover(local=CHECKOUT)["web-toolkit-native"]
    for tool, expected in (
        (published, "git+https://"),
        (local, "file:///"),
        (published, "git+https://"),
    ):
        CatalogueInstaller({tool.name: tool}, target, store).reconcile({tool.name})
        source = json.loads(re.search(r'const SOURCE = ("[^"]+");', extension.read_text(encoding="utf-8"))[1])
        assert source.startswith(expected)
        if expected == "file:///":
            assert source == (CHECKOUT / "harness/productivity/web-toolkit/runtime").as_uri()


def test_local_sources_reject_missing_extension(local_extension):
    checkout, source = local_extension
    (source / "package.json").unlink()
    with pytest.raises(ManifestError, match="invalid local extension source"):
        discover(local=checkout)


def test_local_sources_reject_a_runtime_outside_the_checkout(tmp_path):
    from harness_cli.local_sources import runtime_path

    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "pyproject.toml").write_text('[project]\nversion="1.0.0"\n')
    checkout = tmp_path / "checkout"
    checkout.mkdir()
    with pytest.raises(ValueError, match="invalid local runtime"):
        runtime_path(checkout, "git+https://github.com/EmilienxD/harness@" + "a" * 40 + "#subdirectory=../outside")
