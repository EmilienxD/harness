"""Shared Pi helper selection and receipt-driven removal."""
from dataclasses import replace

import pytest

from harness_cli.installer import CatalogueInstaller, Target
from harness_cli.manifest import discover
from harness_cli.platforms import Platform
from harness_cli.receipts import ReceiptStore


GUARDS = {"on-read-reminder", "on-edit-reminder", "on-edit-block"}
ISSUES = {"issue-readers", "issue-writers"}
TRANSPORT_ONLY = {
    "command-guard", "prefer-fewer-comments", "no-new-documents", "commit",
    "cleanup-git", "grill-me-in-cloud", "enable-desktop-notification", "report-gotchas",
}


@pytest.mark.parametrize("name", sorted(GUARDS | ISSUES | TRANSPORT_ONLY))
def test_tools_install_only_their_required_shared_helpers(tmp_path, name):
    # These checks exercise file/dependency ownership, not host product actions.
    available = {key: replace(tool, actions=()) for key, tool in discover().items()}
    installer = CatalogueInstaller(
        available, Target.for_project(tmp_path / "project", Platform.PI),
        ReceiptStore.load(tmp_path / "receipts.json"),
    )
    expected = {name, "pi-transport"}
    if name in GUARDS:
        expected.add("pi-path-guards")
    if name in ISSUES:
        expected.add("pi-issue-workflows")

    installer.reconcile({name})

    assert set(installer.installation["packages"]) == expected
    hooks = tmp_path / "project/.pi/hooks"
    assert (hooks / "pi-transport/transport.ts").is_file()
    assert (hooks / "pi-path-guards/path_guards.ts").is_file() == (name in GUARDS)
    assert (hooks / "pi-path-guards/path_guards.py").is_file() == (name in GUARDS)
    assert (hooks / "pi-issue-workflows/workflows.ts").is_file() == (name in ISSUES)
    installer.reconcile(set())
    assert installer.installation["packages"] == {}
    assert not (hooks / "pi-transport").exists()


def test_shared_transport_survives_removal_of_other_helper_families(tmp_path):
    available = discover()
    installer = CatalogueInstaller(
        available, Target.for_project(tmp_path / "project", Platform.PI),
        ReceiptStore.load(tmp_path / "receipts.json"),
    )
    installer.reconcile({"on-edit-block", "issue-readers", "command-guard"})
    installer.reconcile({"issue-readers", "command-guard"})
    hooks = tmp_path / "project/.pi/hooks"
    assert not (hooks / "pi-path-guards").exists()
    assert (hooks / "pi-issue-workflows/workflows.ts").is_file()
    assert (hooks / "pi-transport/transport.ts").is_file()
    installer.reconcile({"command-guard"})
    assert not (hooks / "pi-issue-workflows").exists()
    assert (hooks / "pi-transport/transport.ts").is_file()
    installer.reconcile(set())
    assert not (hooks / "pi-transport").exists()
