"""Policy operations and receipt ownership for the shipped Pi path guards."""
import importlib.util
from pathlib import Path

import pytest

from harness_cli.installer import CatalogueInstaller, Target
from harness_cli.manifest import ManifestError, discover, load_tool
from harness_cli.platforms import Platform
from harness_cli.receipts import ReceiptStore

ROOT = Path(__file__).resolve().parents[2]
PACKAGES = ("on-read-reminder", "on-edit-reminder", "on-edit-block")


def load(path):
    spec = importlib.util.spec_from_file_location("pi_guard_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def guard(tmp_path, monkeypatch):
    module = load(ROOT / "harness/internal/pi-path-guards/path_guards.py")
    monkeypatch.setattr(module, "core", lambda package: load(
        ROOT / "harness/guards" / package / (package.replace("-", "_") + "_hook.py")
    ))
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "home")
    (tmp_path / ".harness/guards").mkdir(parents=True)
    (tmp_path / "guide.md").write_text("conventions\n" * 1200, newline="\n")
    for package in PACKAGES:
        (tmp_path / ".harness/guards" / f"{package}.toml").write_text(
            'version = 1\n[[rules]]\npatterns = ["target.txt"]\nrequire = ["guide.md"]\n'
        )
    return module


def request(tmp_path, **kwargs):
    return {"version": 1, "package": "on-edit-block", "cwd": str(tmp_path), "phase": "call",
            "tool": "write", "input": {"path": "target.txt"}, "receipts": [], **kwargs}


def test_shell_read_requires_complete_successful_observed_output(guard, tmp_path):
    content = (tmp_path / "guide.md").read_text()
    for tool, command in [("bash", "cat guide.md"), ("powershell", "Get-Content -Raw guide.md")]:
        observed = request(tmp_path, phase="result", tool=tool, input={"command": command}, text=content)
        receipts = guard.evaluate(observed)["receipts"]
        assert not guard.evaluate(request(tmp_path, receipts=receipts))["block"]
        for overrides in ({"isError": True}, {"text": "partial"}, {"input": {"command": command + " | head -n 1"}}):
            receipts = guard.evaluate({**observed, **overrides})["receipts"]
            assert guard.evaluate(request(tmp_path, receipts=receipts))["block"]


def test_truncated_read_does_not_grant_unseen_lines(guard, tmp_path):
    observed = request(tmp_path, phase="result", tool="read", input={"path": "guide.md"},
                       text="conventions\n", details={"truncation": {"truncated": True, "outputLines": 1}})
    receipts = guard.evaluate(observed)["receipts"]
    assert receipts[0]["end"] == 1
    assert guard.evaluate(request(tmp_path, receipts=receipts))["block"]
    observed["details"]["truncation"]["firstLineExceedsLimit"] = True
    assert guard.evaluate(observed)["receipts"] == []


def test_read_receipt_invalidated_when_guidance_changes(guard, tmp_path):
    observed = request(tmp_path, phase="result", tool="read", input={"path": "guide.md"}, text=(tmp_path / "guide.md").read_text())
    receipts = guard.evaluate(observed)["receipts"]
    assert not guard.evaluate(request(tmp_path, receipts=receipts))["block"]
    (tmp_path / "guide.md").write_text("changed\n" * 1200, newline="\n")
    assert guard.evaluate(request(tmp_path, receipts=receipts))["block"]


def test_edit_reminder_deduplicates_invalid_policy_diagnostics(guard, tmp_path):
    (tmp_path / ".harness/guards/on-edit-reminder.toml").write_text("invalid TOML")
    event = request(tmp_path, package="on-edit-reminder", phase="result")
    first = guard.evaluate(event)
    assert first["message"]
    assert not first["block"]
    assert guard.evaluate({**event, "receipts": first["receipts"]})["message"] == ""


@pytest.mark.parametrize("platform", [Platform.CLAUDE, Platform.PI])
def test_pi_guard_dependencies_are_filtered_and_coupled(tmp_path, platform):
    installer = CatalogueInstaller(discover(), Target.for_project(tmp_path / "project", platform), ReceiptStore.load(tmp_path / "receipts.json"))
    installer.reconcile(set(PACKAGES))
    expected = set(PACKAGES) | ({"pi-path-guards", "pi-transport"} if platform is Platform.PI else set())
    assert set(installer.installation["packages"]) == expected
    installer.reconcile({"on-edit-block"})
    assert set(installer.installation["packages"]) == {"on-edit-block"} | ({"pi-path-guards", "pi-transport"} if platform is Platform.PI else set())
    installer.reconcile(set())
    assert installer.installation["packages"] == {}


@pytest.mark.parametrize("platforms", ['"pi"', '[]', '["unknown"]'])
def test_invalid_dependency_platform_filter_rejected(tmp_path, platforms):
    (tmp_path / "payload").write_text("payload")
    (tmp_path / "harness.toml").write_text(f'''name = "example"
version = "1.0.0"
description = "Example"
dependencies = [{{name = "support", platforms = {platforms}}}]
[platforms.pi]
status = "supported"
[[files]]
src = "payload"
dest = "payload"
''')
    with pytest.raises(ManifestError, match="dependency platforms"):
        load_tool(tmp_path)
