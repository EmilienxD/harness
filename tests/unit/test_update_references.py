from email.message import Message
from urllib.error import URLError
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import update_references


class Response:
    def __init__(self, body: bytes):
        self.body = body
        self.headers = Message()
        self.headers["Content-Type"] = "text/markdown; charset=utf-8"

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self):
        return self.body


def test_update_reference_set_downloads_every_indexed_file(tmp_path, monkeypatch):
    (tmp_path / "README.md").write_text(
        "# References\n\n"
        "- [One](./one.md)\n  - Source: https://example.test/one.md\n\n"
        "- [Two](./nested/two.md)\n  - Source: https://example.test/two.md?surface=cli\n",
        encoding="utf-8",
    )
    payloads = {
        "https://example.test/one.md": b"# One\n",
        "https://example.test/two.md?surface=cli": b"# Two\n",
    }
    monkeypatch.setattr(
        update_references,
        "urlopen",
        lambda request, timeout: Response(payloads[request.full_url]),
    )

    assert update_references.update_reference_set(tmp_path) == 2
    assert (tmp_path / "one.md").read_text(encoding="utf-8") == "# One\n"
    assert (tmp_path / "nested/two.md").read_text(encoding="utf-8") == "# Two\n"


def test_update_reference_set_rejects_an_empty_index(tmp_path):
    (tmp_path / "README.md").write_text("# References\n", encoding="utf-8")

    with pytest.raises(update_references.ReferenceUpdateError, match="no references"):
        update_references.update_reference_set(tmp_path)


@pytest.mark.parametrize("name", sorted(update_references.REFERENCE_SETS))
def test_known_reference_set_does_not_need_a_nested_readme(tmp_path, monkeypatch, name):
    reference_root = tmp_path / name
    reference_root.mkdir()
    monkeypatch.setattr(
        update_references,
        "urlopen",
        lambda request, timeout: Response(f"# {request.full_url}\n".encode()),
    )

    references = update_references.REFERENCE_SETS[name]
    assert update_references.update_reference_set(reference_root) == len(references)
    for _, local_file, url in references:
        assert (reference_root / local_file).read_text(encoding="utf-8") == f"# {url}\n"


def test_pi_index_matches_bootstrap_sources():
    root = Path(__file__).resolve().parents[2] / "docs" / "PI-REFERENCES"
    indexed = update_references.REFERENCE_PATTERN.findall(
        (root / "README.md").read_text(encoding="utf-8")
    )
    assert indexed == list(update_references.REFERENCE_SETS["PI-REFERENCES"])
    destinations = [local for _, local, _ in indexed]
    assert len(destinations) == len(set(destinations))
    for _, local, url in indexed:
        assert (root / local).is_file()
        assert url.startswith(update_references.PI_SOURCE_ROOT + "/")


def test_failed_fetch_preserves_existing_mirror_and_reports_error(tmp_path, monkeypatch, capsys):
    root = tmp_path / "PI-REFERENCES"
    root.mkdir()
    (root / "README.md").write_text(
        "- [One](./one.md)\n  - Source: https://example.test/one.md\n",
        encoding="utf-8",
    )
    (root / "one.md").write_text("Previous documentation\n", encoding="utf-8")

    def fail_fetch(_url):
        raise URLError("source unavailable")

    monkeypatch.setattr(update_references, "fetch_text", fail_fetch)
    assert update_references.main([str(root)]) == 1
    assert (root / "one.md").read_text(encoding="utf-8") == "Previous documentation\n"
    assert "source unavailable" in capsys.readouterr().err


@pytest.mark.parametrize("body", ["", "  \n"])
def test_empty_response_preserves_existing_mirror(tmp_path, monkeypatch, body):
    (tmp_path / "README.md").write_text(
        "- [One](./one.md)\n  - Source: https://example.test/one.md\n",
        encoding="utf-8",
    )
    (tmp_path / "one.md").write_text("Previous documentation\n", encoding="utf-8")
    monkeypatch.setattr(update_references, "fetch_text", lambda _url: body)
    with pytest.raises(update_references.ReferenceUpdateError, match="empty response"):
        update_references.update_reference_set(tmp_path)
    assert (tmp_path / "one.md").read_text(encoding="utf-8") == "Previous documentation\n"


def test_reference_workflow_refreshes_and_stages_every_provider():
    import yaml

    workflow = Path(__file__).resolve().parents[2] / ".github/workflows/update-references.yml"
    steps = yaml.safe_load(workflow.read_text(encoding="utf-8"))["jobs"]["update"]["steps"]
    update = next(step["run"] for step in steps if step.get("name") == "Update reference sets")
    commit = next(step["run"] for step in steps if step.get("name") == "Commit changes")
    staged = next(line.strip().split()[2:] for line in commit.splitlines() if "git add " in line)
    for name in update_references.REFERENCE_SETS:
        assert f"docs/{name}" in update.split()
        assert f"docs/{name}" in staged
