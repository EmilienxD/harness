from email.message import Message
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
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
