"""Shared Pi helper selection and receipt-driven removal."""
from dataclasses import replace

import pytest

from harness_cli.installer import CatalogueInstaller, Target
from harness_cli.manifest import SupportStatus, discover
from harness_cli.platforms import Platform, get_adapter
from harness_cli.receipts import ReceiptStore
from harness_cli.pi_packages import package_root


GUARDS = {"on-read-reminder", "on-edit-reminder", "on-edit-block"}
ISSUES = {"issue-readers", "issue-writers"}
TRANSPORT_ONLY = {
    "command-guard", "prefer-fewer-comments", "no-new-documents", "commit",
    "cleanup-git", "grill-me-in-cloud", "enable-desktop-notification",
}


@pytest.mark.parametrize("scope", ("project", "user"))
def test_pi_support_destination_and_placeholders(tmp_path, monkeypatch, scope):
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(tmp_path / "agent"))
    target = (
        Target.for_user(Platform.PI)
        if scope == "user"
        else Target.for_project(tmp_path / "project", Platform.PI)
    )
    assert target.destination_path("support", "helper.py") == target.install_root / "harness/helper.py"
    with pytest.raises(ValueError, match="Pi does not support the hooks destination"):
        target.destination_path("hooks", "helper.py")
    assert target.adapter.placeholders(target.scope_root, target.is_user) == {
        "${PLATFORM_DIR}": target.install_root.as_posix(),
        "${SKILLS_DIR}": (target.install_root / "skills").as_posix(),
        "${SUPPORT_DIR}": (target.install_root / "harness").as_posix(),
    }


@pytest.mark.parametrize("platform", (Platform.CLAUDE, Platform.CHATGPT))
def test_hook_providers_keep_their_hook_destination(tmp_path, platform):
    adapter = get_adapter(platform)
    assert adapter.destination_root(tmp_path, False, "hooks") == adapter.platform_root(tmp_path, False) / "hooks"
    assert "${HOOKS_DIR}" in adapter.placeholders(tmp_path, False)
    with pytest.raises(ValueError, match="unknown destination root"):
        adapter.destination_root(tmp_path, False, "support")


@pytest.mark.parametrize("scope", ("project", "user"))
def test_fresh_pi_catalogue_installs_without_a_hooks_directory(tmp_path, monkeypatch, scope):
    # Exercise every supported package, including non-selectable integration payloads,
    # while leaving machine-wide products and prerequisite probing out of this file test.
    available = {
        name: replace(tool, actions=(), requires=())
        for name, tool in discover().items()
    }
    selected = {
        name for name, tool in available.items()
        if tool.support_for(Platform.PI).status is SupportStatus.SUPPORTED
    }
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(tmp_path / "agent"))
    target = (
        Target.for_user(Platform.PI)
        if scope == "user"
        else Target.for_project(tmp_path / "project", Platform.PI)
    )
    installer = CatalogueInstaller(available, target, ReceiptStore.load(tmp_path / "receipts.json"))

    installer.reconcile(selected)

    assert selected <= set(installer.installation["packages"])
    assert not (target.install_root / "hooks").exists()
    command_skills = {
        "auto": ("auto",),
        "commit": ("commit",),
        "issue-writers": ("publish-issues",),
        "no-new-documents": ("approve-doc-draft", "reject-doc-draft"),
        "enable-desktop-notification": ("enable-desktop-notification",),
        "subagents": ("reply-to-agent-with-previous-message",),
    }
    for package, names in command_skills.items():
        installed = package_root(target.install_root, package)
        assert (installed / "extensions").is_dir(), package
        for name in names:
            assert not (installed / "skills" / name).exists(), (package, name)
    # Agent workflows in mixed command/skill packages still load their instructions.
    assert (package_root(target.install_root, "issue-writers") / "skills/draft-issue/SKILL.md").is_file()
    assert (package_root(target.install_root, "subagents") / "skills/reply-to-agent/SKILL.md").is_file()
    assert (package_root(target.install_root, "pi-transport") / "harness/pi-transport/transport.ts").is_file()
    assert (package_root(target.install_root, "command-guard") / "extensions/.harness-command-guard/index.ts").is_file()
    for name in selected:
        for payload in installer._payloads(available[name]):
            assert payload.root != "hooks", name
            assert target.destination_path(payload.root, payload.dest).is_file(), (name, payload.dest)

    installer.reconcile(set())

    assert installer.installation["packages"] == {}
    assert not (target.install_root / "harness/pi-transport").exists()
    assert not (target.install_root / "hooks").exists()


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
        expected.update({"pi-path-guards", "path-guard-common"})
    if name in ISSUES:
        expected.add("pi-issue-workflows")

    installer.reconcile({name})

    assert set(installer.installation["packages"]) == expected
    support = package_root(installer.target.install_root, name) / "harness"
    assert (support / "pi-transport/transport.ts").is_file()
    assert (support / "pi-path-guards/path_guards.ts").is_file() == (name in GUARDS)
    assert (support / "pi-path-guards/path_guards.py").is_file() == (name in GUARDS)
    assert (support / "pi-issue-workflows/workflows.ts").is_file() == (name in ISSUES)
    installer.reconcile(set())
    assert installer.installation["packages"] == {}
    assert not (support / "pi-transport").exists()


def test_shared_transport_survives_removal_of_other_helper_families(tmp_path):
    available = discover()
    installer = CatalogueInstaller(
        available, Target.for_project(tmp_path / "project", Platform.PI),
        ReceiptStore.load(tmp_path / "receipts.json"),
    )
    installer.reconcile({"on-edit-block", "issue-readers", "command-guard"})
    installer.reconcile({"issue-readers", "command-guard"})
    platform = installer.target.install_root
    assert not package_root(platform, "pi-path-guards").exists()
    assert (package_root(platform, "issue-readers") / "harness/pi-issue-workflows/workflows.ts").is_file()
    assert (package_root(platform, "command-guard") / "harness/pi-transport/transport.ts").is_file()
    installer.reconcile({"command-guard"})
    assert not package_root(platform, "pi-issue-workflows").exists()
    assert (package_root(platform, "command-guard") / "harness/pi-transport/transport.ts").is_file()
    installer.reconcile(set())
    assert not package_root(platform, "pi-transport").exists()
