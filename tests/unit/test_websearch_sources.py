from pathlib import Path

from harness_cli.installer import CatalogueInstaller, Target
from harness_cli.manifest import discover
from harness_cli.receipts import ReceiptStore


SOURCE_DIR = Path(__file__).parents[2] / "harness" / "planning" / "websearch"


def test_installed_source_index_is_a_markdown_starter() -> None:
    assert (SOURCE_DIR / "INDEX.md").read_text(encoding="utf-8") == (
        "# INDEX\n\n> List `title: source` bellow."
    )
    assert not (SOURCE_DIR / "sources.py").exists()
    assert not (SOURCE_DIR / "sources.json").exists()


def test_claude_and_chatgpt_share_one_editable_project_index(tmp_path) -> None:
    store = ReceiptStore.load(tmp_path / "receipts.json")
    project = tmp_path / "project"
    claude_target = Target.for_project(project, "claude")
    chatgpt_target = Target.for_project(project, "chatgpt")

    claude = CatalogueInstaller(discover(), claude_target, store)
    chatgpt = CatalogueInstaller(discover(), chatgpt_target, store)
    claude.reconcile({"websearch"})
    index = project / ".harness" / "websearch" / "INDEX.md"
    assert index.is_file()

    edited = "# INDEX\n\n- Python: https://docs.python.org/3/"
    index.write_text(edited, encoding="utf-8")
    chatgpt.reconcile({"websearch"})

    assert index.read_text(encoding="utf-8") == edited
    assert not claude_target.destination_path("skills", "websearch/INDEX.md").exists()
    assert not chatgpt_target.destination_path("skills", "websearch/INDEX.md").exists()

    claude.reconcile(set())
    chatgpt.reconcile(set())

    assert index.read_text(encoding="utf-8") == edited


def test_shared_unmodified_index_is_removed_after_both_platforms_are_uninstalled(
    tmp_path,
) -> None:
    store = ReceiptStore.load(tmp_path / "receipts.json")
    project = tmp_path / "project"
    claude = CatalogueInstaller(discover(), Target.for_project(project, "claude"), store)
    chatgpt = CatalogueInstaller(discover(), Target.for_project(project, "chatgpt"), store)

    claude.reconcile({"websearch"})
    chatgpt.reconcile({"websearch"})
    index = project / ".harness" / "websearch" / "INDEX.md"

    claude.reconcile(set())
    assert index.is_file()

    chatgpt.reconcile(set())
    assert not index.exists()
