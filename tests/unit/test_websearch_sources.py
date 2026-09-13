import json
import shutil
import subprocess
import sys
from pathlib import Path


SOURCE_DIR = Path(__file__).parents[2] / "harness" / "planning" / "websearch"


def run_sources(skill_dir: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(skill_dir / "sources.py"), *args],
        capture_output=True,
        check=False,
        text=True,
    )


def test_installed_source_index_starts_empty() -> None:
    assert json.loads((SOURCE_DIR / "sources.json").read_text(encoding="utf-8")) == {}


def test_agent_can_add_and_find_a_source(tmp_path: Path) -> None:
    shutil.copy2(SOURCE_DIR / "sources.py", tmp_path / "sources.py")
    shutil.copy2(SOURCE_DIR / "sources.json", tmp_path / "sources.json")

    added = run_sources(
        tmp_path,
        "add",
        "Python documentation",
        "https://docs.python.org/3/",
    )
    found = run_sources(tmp_path, "search", "python")

    assert added.returncode == 0
    assert found.returncode == 0
    assert found.stdout == "Python documentation: https://docs.python.org/3/\n"


def test_agent_can_tell_when_the_knowledge_base_has_no_match(tmp_path: Path) -> None:
    shutil.copy2(SOURCE_DIR / "sources.py", tmp_path / "sources.py")
    shutil.copy2(SOURCE_DIR / "sources.json", tmp_path / "sources.json")

    result = run_sources(tmp_path, "search", "unknown-library")

    assert result.returncode == 0
    assert result.stdout == "No sources found.\n"
