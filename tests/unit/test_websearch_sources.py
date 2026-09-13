from pathlib import Path


SOURCE_DIR = Path(__file__).parents[2] / "harness" / "planning" / "websearch"


def test_installed_source_index_is_a_markdown_starter() -> None:
    assert (SOURCE_DIR / "INDEX.md").read_text(encoding="utf-8") == (
        "# INDEX\n\n> List `title: source` bellow."
    )
    assert not (SOURCE_DIR / "sources.py").exists()
    assert not (SOURCE_DIR / "sources.json").exists()
