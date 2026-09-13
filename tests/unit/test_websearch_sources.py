from pathlib import Path


SOURCE_DIR = Path(__file__).parents[2] / "harness" / "planning" / "websearch"


def test_installed_source_index_starts_empty_and_uses_markdown() -> None:
    assert (SOURCE_DIR / "sources.md").read_text(encoding="utf-8") == ""
    assert not (SOURCE_DIR / "sources.py").exists()
    assert not (SOURCE_DIR / "sources.json").exists()
