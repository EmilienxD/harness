"""Native package declarations and receipt-driven Pi extension migration."""

import json
from dataclasses import replace
from pathlib import Path
import pytest

from harness_cli.installer import CatalogueInstaller, InstallError, Target, sha256
from harness_cli.manifest import FileSpec, PlatformSupport, SupportStatus, Tool
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


def test_pi_extension_uses_native_package_identity_and_preserves_personal_settings(tmp_path):
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
        "extensions": ["../../../extensions/.harness-scope-probe"],
    }
    assert installer.reconcile({tool.name}) == []
    CatalogueInstaller({tool.name: tool}, target, ReceiptStore.load(store.path)).reconcile(set())
    assert json.loads(target.settings_path.read_text()) == {"theme": "personal", "packages": ["./personal"]}
    assert not manifest.exists()
    assert not (target.install_root / "harness/packages/scope-probe.tgz").exists()
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


def test_upgrade_removes_legacy_discovery_entry_and_rejects_modified_entry(tmp_path):
    tool = probe_tool(tmp_path)
    target = Target.for_project(tmp_path / "project", Platform.PI)
    store = ReceiptStore.load(tmp_path / "receipts.json")
    legacy = target.install_root / "extensions/harness-scope-probe/index.ts"
    legacy.parent.mkdir(parents=True)
    legacy.write_text("export default function(pi) {}", encoding="utf-8")
    target.installation(store, create=True)["packages"][tool.name] = {
        "version": "1.0.0", "ownership": "selected", "dependencies": [],
        "files": [{"path": str(legacy), "digest": sha256(legacy), "owned": True}],
    }
    legacy.write_text("// personal change\nexport default function(pi) {}", encoding="utf-8")
    installer = CatalogueInstaller({tool.name: tool}, target, store)
    with pytest.raises(InstallError):
        installer.reconcile({tool.name})
    assert legacy.is_file()
    assert not target.settings_path.exists()

    legacy.write_text("export default function(pi) {}", encoding="utf-8")
    installer.reconcile({tool.name})
    assert not legacy.exists()
    assert (target.install_root / "extensions/.harness-scope-probe/index.ts").is_file()


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
