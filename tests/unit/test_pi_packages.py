"""Self-contained npm payloads and Pi-owned package lifecycles."""

import json
import tarfile
from dataclasses import replace
from pathlib import Path
import pytest

from harness_cli.installer import CatalogueInstaller, InstallError, Target
from harness_cli import pi_packages
from harness_cli.manifest import FileSpec, PackageDependency, PlatformSupport, SupportStatus, Tool
from harness_cli.platforms import Platform
from harness_cli.receipts import ReceiptStore


def probe_tool(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    (source / "extension.ts").write_text("export default function(pi) {}", encoding="utf-8")
    return Tool(
        name="scope-probe", version="1.0.1", description="Scope probe", root=source,
        files=(FileSpec("extension.ts", ".harness-scope-probe/index.ts", "extensions"),),
        platform_support={Platform.PI: PlatformSupport(SupportStatus.SUPPORTED)},
    )


def test_pi_extension_uses_native_package_identity_and_preserves_personal_settings(tmp_path, fake_pi_packages):
    tool = probe_tool(tmp_path)
    target = Target.for_project(tmp_path / "project", Platform.PI)
    target.settings_path.parent.mkdir(parents=True)
    target.settings_path.write_text('{"theme":"personal","packages":["./personal"]}', encoding="utf-8")
    store = ReceiptStore.load(tmp_path / "receipts.json")
    installer = CatalogueInstaller({tool.name: tool}, target, store)

    installer.reconcile({tool.name})

    source = target.read_settings()["packages"][1]
    assert source.startswith("npm:harness-pi-scope-probe@file:")
    archive = Path(source.split("@file:", 1)[1])
    assert archive.is_relative_to(tmp_path / "pi-packages")
    assert archive.is_file()
    assert json.loads(target.settings_path.read_text()) == {
        "theme": "personal", "packages": ["./personal", source],
    }
    manifest = target.install_root / "npm/node_modules/harness-pi-scope-probe/package.json"
    assert json.loads(manifest.read_text())["pi"] == {
        "extensions": ["extensions/.harness-scope-probe"], "skills": [],
    }
    extension = manifest.parent / "extensions/.harness-scope-probe/index.ts"
    assert extension.read_bytes() == (tool.root / "extension.ts").read_bytes()
    with tarfile.open(archive) as tar:
        assert set(tar.getnames()) == {"package/package.json", "package/extensions/.harness-scope-probe/index.ts"}
    assert not (target.install_root / "harness/packages").exists()
    assert not (target.install_root / "extensions").exists()
    assert installer.reconcile({tool.name}) == []
    assert len(fake_pi_packages) == 1
    CatalogueInstaller({tool.name: tool}, target, ReceiptStore.load(store.path)).reconcile(set())
    assert json.loads(target.settings_path.read_text()) == {"theme": "personal", "packages": ["./personal"]}
    assert not manifest.exists()
    assert [call[0] for call in fake_pi_packages] == ["install", "remove"]
    assert archive.is_file(), "Copied worktrees can still reference this immutable archive"


@pytest.mark.parametrize("newline", ["\n", "\r\n"])
@pytest.mark.parametrize("bom", [b"", b"\xef\xbb\xbf"])
def test_pi_install_and_removal_preserve_settings_line_endings_and_bom(tmp_path, newline, bom):
    tool = probe_tool(tmp_path)
    target = Target.for_project(tmp_path / "project", Platform.PI)
    target.settings_path.parent.mkdir(parents=True)
    original = bom + ('{\n  "theme": "personal"\n}\n'.replace("\n", newline)).encode("utf-8")
    target.settings_path.write_bytes(original)
    installer = CatalogueInstaller({tool.name: tool}, target, ReceiptStore.load(tmp_path / "receipts.json"))

    installer.reconcile({tool.name})
    installed = target.settings_path.read_bytes()
    assert installed.startswith(bom + b"{")
    assert installed.count(b"\r\n") == (installed.count(b"\n") if newline == "\r\n" else 0)
    assert target.read_settings()["theme"] == "personal"
    installer.reconcile(set())
    assert target.settings_path.read_bytes() == original


def test_modified_native_package_blocks_upgrade_and_removal(tmp_path):
    tool = probe_tool(tmp_path)
    target = Target.for_project(tmp_path / "project", Platform.PI)
    store = ReceiptStore.load(tmp_path / "receipts.json")
    installer = CatalogueInstaller({tool.name: tool}, target, store)
    installer.reconcile({tool.name})
    extension = target.install_root / "npm/node_modules/harness-pi-scope-probe/extensions/.harness-scope-probe/index.ts"
    extension.write_text("// personal change", encoding="utf-8")
    for requested in ({tool.name}, set()):
        with pytest.raises(InstallError, match="modified"):
            installer.reconcile(requested)
        assert extension.read_text() == "// personal change"


def test_install_respects_existing_package_filters(tmp_path):
    tool = probe_tool(tmp_path)
    target = Target.for_project(tmp_path / "project", Platform.PI)
    store = ReceiptStore.load(tmp_path / "receipts.json")
    user = Target(tmp_path / "agent", target.adapter, True)
    CatalogueInstaller({tool.name: tool}, user, store).reconcile({tool.name})
    target.settings_path.parent.mkdir(parents=True)
    settings = {"packages": [{
        "source": user.read_settings()["packages"][0],
        "extensions": [],
    }]}
    target.settings_path.write_text(json.dumps(settings), encoding="utf-8")
    installer = CatalogueInstaller({tool.name: tool}, target, store)
    installer.reconcile({tool.name})
    assert target.read_settings() == settings
    installer.reconcile(set())
    assert target.read_settings() == settings


def test_uninstall_removes_owned_package_after_pi_config_adds_filters(tmp_path):
    tool = probe_tool(tmp_path)
    target = Target.for_project(tmp_path / "project", Platform.PI)
    installer = CatalogueInstaller({tool.name: tool}, target, ReceiptStore.load(tmp_path / "receipts.json"))
    installer.reconcile({tool.name})
    source = target.read_settings()["packages"][0]
    target.settings_path.write_text(json.dumps({"theme": "personal", "packages": [
        {"source": source, "extensions": []}, "./personal",
    ]}), encoding="utf-8")
    installer.reconcile(set())
    assert target.read_settings() == {"theme": "personal", "packages": ["./personal"]}


def test_install_refuses_an_existing_different_source_with_the_same_native_identity(tmp_path):
    tool = probe_tool(tmp_path)
    target = Target.for_project(tmp_path / "project", Platform.PI)
    target.settings_path.parent.mkdir(parents=True)
    original = '{"packages":["npm:harness-pi-scope-probe@9.0.0"]}'
    target.settings_path.write_text(original, encoding="utf-8")
    installer = CatalogueInstaller({tool.name: tool}, target, ReceiptStore.load(tmp_path / "receipts.json"))
    with pytest.raises(InstallError, match="another source"):
        installer.reconcile({tool.name})
    assert target.settings_path.read_text() == original
    assert not (target.install_root / "extensions/.harness-scope-probe/index.ts").exists()


def test_upgrade_preserves_filters_of_an_owned_package(tmp_path):
    tool = probe_tool(tmp_path)
    target = Target.for_project(tmp_path / "project", Platform.PI)
    store = ReceiptStore.load(tmp_path / "receipts.json")
    CatalogueInstaller({tool.name: tool}, target, store).reconcile({tool.name})
    settings = {"packages": [{"source": target.read_settings()["packages"][0], "extensions": []}]}
    target.settings_path.write_text(json.dumps(settings), encoding="utf-8")
    newer = replace(tool, version="1.0.2")
    installer = CatalogueInstaller({tool.name: newer}, target, store)
    installer.reconcile({tool.name})
    upgraded = target.read_settings()["packages"][0]
    assert upgraded["extensions"] == []
    assert upgraded["source"] != settings["packages"][0]["source"]
    assert Path(upgraded["source"].split("@file:", 1)[1]).is_file()
    installer.reconcile(set())
    assert target.read_settings() == {}


@pytest.mark.parametrize("operation", ["install", "remove"])
def test_failed_native_command_restores_package_settings_and_receipts(tmp_path, monkeypatch, operation):
    tool = probe_tool(tmp_path)
    target = Target.for_project(tmp_path / "project", Platform.PI)
    store = ReceiptStore.load(tmp_path / "receipts.json")
    installer = CatalogueInstaller({tool.name: tool}, target, store)
    target.settings_path.parent.mkdir(parents=True)
    target.settings_path.write_text('{"theme":"personal"}\n', encoding="utf-8")
    if operation == "remove":
        installer.reconcile({tool.name})
    assert installer.installation is not None
    before = {path.relative_to(target.install_root): path.read_bytes()
              for path in target.install_root.rglob("*") if path.is_file()}
    receipts_before = json.loads(json.dumps(store.data))
    native_run = pi_packages.run

    def fail_after_mutation(*args):
        native_run(*args)
        metadata = target.install_root / "npm/package-lock.json"
        metadata.parent.mkdir(parents=True, exist_ok=True)
        metadata.write_text('{"partial":true}', encoding="utf-8")
        raise pi_packages.PiPackageError("simulated native command failure")

    monkeypatch.setattr(pi_packages, "run", fail_after_mutation)
    with pytest.raises(InstallError, match="simulated native command failure"):
        installer.reconcile({tool.name} if operation == "install" else set())
    after = {path.relative_to(target.install_root): path.read_bytes()
             for path in target.install_root.rglob("*") if path.is_file()}
    assert after == before
    assert store.data == receipts_before


def test_helper_update_rebuilds_transitive_consumers_after_a_preserved_preview(tmp_path):
    app = probe_tool(tmp_path)
    helper_source = tmp_path / "helper.py"
    helper_source.write_text("value = 1\n", encoding="utf-8")
    helper = replace(app, name="helper", files=(FileSpec("helper.py", "helper.py", "support"),), root=tmp_path)
    middle = replace(app, name="middle", files=(), dependencies=(PackageDependency("helper"),))
    # A support package with its own payload bundles its dependency transitively.
    middle_source = tmp_path / "middle.py"
    middle_source.write_text("import helper\n", encoding="utf-8")
    middle = replace(middle, root=tmp_path, files=(FileSpec("middle.py", "middle.py", "support"),))
    app = replace(app, dependencies=(PackageDependency("middle"),))
    available = {tool.name: tool for tool in (app, middle, helper)}
    target = Target.for_project(tmp_path / "project", Platform.PI)
    store = ReceiptStore.load(tmp_path / "receipts.json")
    initial = CatalogueInstaller(available, target, store)
    initial.reconcile({app.name})
    sources = {name: receipt["piPackage"] for name, receipt in initial.installation["packages"].items()}

    helper_source.write_text("value = 2\n", encoding="utf-8")
    available[helper.name] = replace(helper, version="1.0.2")
    installer = CatalogueInstaller(available, target, store)
    installer.update_packages = set()
    installer.plan({app.name})
    installer.update_packages = {helper.name}
    installer.reconcile({app.name})

    for name in available:
        assert installer.installation["packages"][name]["piPackage"] != sources[name]
        bundled = pi_packages.package_root(target.install_root, name) / "harness/helper.py"
        assert bundled.read_text() == "value = 2\n"
