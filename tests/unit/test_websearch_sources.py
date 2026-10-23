from pathlib import Path

import pytest

from harness_cli.installer import CatalogueInstaller, InstallError, Target
from harness_cli.manifest import discover
from harness_cli.receipts import ReceiptStore


SOURCE_DIR = Path(__file__).parents[2] / "harness" / "planning" / "websearch"


def test_installed_source_index_is_a_markdown_starter() -> None:
    assert (SOURCE_DIR / "INDEX.md").read_text(encoding="utf-8") == (
        "# INDEX\n\n> List `title: source` bellow."
    )
    assert not (SOURCE_DIR / "sources.py").exists()
    assert not (SOURCE_DIR / "sources.json").exists()


@pytest.mark.parametrize("second_platform", ["chatgpt", "pi"])
def test_platforms_share_one_editable_project_index(tmp_path, second_platform) -> None:
    store = ReceiptStore.load(tmp_path / "receipts.json")
    project = tmp_path / "project"
    claude_target = Target.for_project(project, "claude")
    other_target = Target.for_project(project, second_platform)

    claude = CatalogueInstaller(discover(), claude_target, store)
    other = CatalogueInstaller(discover(), other_target, store)
    claude.reconcile({"websearch"})
    index = project / ".harness" / "websearch" / "INDEX.md"
    assert index.is_file()

    edited = "# INDEX\n\n- Python: https://docs.python.org/3/"
    index.write_text(edited, encoding="utf-8")
    other.reconcile({"websearch"})

    assert index.read_text(encoding="utf-8") == edited
    assert not claude_target.destination_path("skills", "websearch/INDEX.md").exists()
    assert not other_target.destination_path("skills", "websearch/INDEX.md").exists()

    claude.reconcile(set())
    other.reconcile(set())

    assert index.read_text(encoding="utf-8") == edited


@pytest.mark.parametrize("second_platform", ["chatgpt", "pi"])
def test_shared_unmodified_index_is_removed_after_both_platforms_are_uninstalled(
    tmp_path, second_platform,
) -> None:
    store = ReceiptStore.load(tmp_path / "receipts.json")
    project = tmp_path / "project"
    claude = CatalogueInstaller(discover(), Target.for_project(project, "claude"), store)
    other = CatalogueInstaller(discover(), Target.for_project(project, second_platform), store)

    claude.reconcile({"websearch"})
    other.reconcile({"websearch"})
    index = project / ".harness" / "websearch" / "INDEX.md"

    claude.reconcile(set())
    assert index.is_file()

    other.reconcile(set())
    assert not index.exists()


@pytest.mark.parametrize("edited", [False, True])
def test_pi_user_index_is_shared_and_preserves_user_edits(tmp_path, monkeypatch, edited):
    home = tmp_path / "home"
    monkeypatch.setattr(Path, "home", lambda: home)
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(tmp_path / "pi-agent"))
    target = Target.for_user("pi")
    store = ReceiptStore.load(tmp_path / "receipts.json")
    catalogue = CatalogueInstaller(discover(), target, store)

    catalogue.reconcile({"websearch"})

    skill = target.destination_path("skills", "websearch/SKILL.md")
    index = home / ".harness/websearch/INDEX.md"
    assert not skill.with_name("INDEX.md").exists()
    assert skill.read_bytes() == (SOURCE_DIR / "SKILL.md").read_bytes()
    assert index.read_bytes() == (SOURCE_DIR / "INDEX.md").read_bytes()
    assert not skill.with_name("agents").exists()
    assert not (target.install_root / "extensions").exists()
    assert not (target.scope_root / ".harness").exists()
    if edited:
        index.write_text("# INDEX\n\n- Python: https://docs.python.org/3/", encoding="utf-8")
    expected = index.read_bytes()
    catalogue.reconcile({"websearch"})
    assert index.read_bytes() == expected

    reloaded = ReceiptStore.load(store.path)
    CatalogueInstaller(discover(), target, reloaded).reconcile(set())
    assert not skill.exists()
    assert index.exists() is edited
    if edited:
        assert index.read_bytes() == expected


@pytest.mark.parametrize("edited", [False, True])
def test_user_platforms_share_index_across_distinct_receipt_roots(tmp_path, monkeypatch, edited):
    home = tmp_path / "home"
    monkeypatch.setattr(Path, "home", lambda: home)
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(tmp_path / "custom-agent"))
    store = ReceiptStore.load(tmp_path / "receipts.json")
    installers = [
        CatalogueInstaller(discover(), Target.for_user(platform), store)
        for platform in ("pi", "claude", "chatgpt")
    ]
    index = home / ".harness/websearch/INDEX.md"
    installers[0].reconcile({"websearch"})
    if edited:
        index.write_text("# INDEX\n\n- Python: https://docs.python.org/3/", encoding="utf-8")
    expected = index.read_bytes()
    for installer in installers[1:]:
        installer.reconcile({"websearch"})
        assert index.read_bytes() == expected
    for installer in installers[:-1]:
        installer.reconcile(set())
        assert index.read_bytes() == expected
    installers[-1].reconcile(set())
    assert index.exists() is edited


def test_pi_user_receipt_rejects_undeclared_home_paths(tmp_path, monkeypatch):
    home = tmp_path / "home"
    monkeypatch.setattr(Path, "home", lambda: home)
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(tmp_path / "agent"))
    target = Target.for_user("pi")
    store = ReceiptStore.load(tmp_path / "receipts.json")
    installer = CatalogueInstaller(discover(), target, store)
    installer.reconcile({"websearch"})
    receipt = target.installation(store)["packages"]["websearch"]
    receipt["files"].append({"path": str(home / "unrelated.txt"), "owned": True})
    with pytest.raises(InstallError, match="escapes target root"):
        installer.reconcile(set())
