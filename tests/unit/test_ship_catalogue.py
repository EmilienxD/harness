"""Unfinished ship remains source-only."""
from pathlib import Path
from harness_cli.cli import main
from harness_cli.manifest import discover


def test_ship_is_unavailable_without_installing_anything(tmp_path, monkeypatch, capsys):
    root = Path(__file__).resolve().parents[2]
    assert (root / "harness/in-progress/ship/harness.toml").is_file()
    assert "ship" not in discover()
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    assert main(["install", "ship", "--root", str(tmp_path), "--platform", "claude", "--json"]) == 1
    capsys.readouterr()
    assert not (tmp_path / ".claude").exists()
    assert not (tmp_path / "state/receipts.json").exists()
