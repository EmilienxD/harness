"""A real Git checkout exercises the Lead's structural Python test contract."""
import importlib.util
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("ship_stubs", ROOT / "harness/building/ship/ship_stubs.py")
ship_stubs = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ship_stubs)


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


def test_stub_contract_allows_only_filling_anchored_tests(tmp_path, capsys):
    git(tmp_path, "init", "-b", "main")
    git(tmp_path, "config", "user.name", "Test")
    git(tmp_path, "config", "user.email", "test@example.com")
    (tmp_path / "app.py").write_text("value = 1\n")
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-m", "base")
    base = git(tmp_path, "rev-parse", "HEAD")
    tests = tmp_path / "tests/unit"
    tests.mkdir(parents=True)
    source = 'def test_value():\n    """The value is one."""\n    assert False, "stub"\n'
    stub = tests / "test_value.py"
    stub.write_text(source)
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-m", "criteria")
    anchor = git(tmp_path, "rev-parse", "HEAD")
    arguments = ["check", "--root", str(tmp_path), "--base", base, "--anchor", anchor]
    assert ship_stubs.main(arguments) == 1  # Deliberate failure is still a stub.
    stub.write_text(source.replace('assert False, "stub"', 'assert 1 == 1'))
    assert ship_stubs.main(arguments) == 0
    stub.write_text('import pytest\n@pytest.mark.skip\n' + stub.read_text())
    assert ship_stubs.main(arguments) == 1
    stub.write_text(source.replace('assert False, "stub"', 'assert 1 == 1'))
    stub.write_text(stub.read_text().replace("test_value", "test_renamed"))
    assert ship_stubs.main(arguments) == 1
    stub.write_text(source.replace('assert False, "stub"', 'assert 1 == 1'))
    (tmp_path / "other_test.py").write_text("def test_extra():\n    assert True\n")
    assert ship_stubs.main(arguments) == 1  # Untracked tests outside the stub folder count.
    capsys.readouterr()


def test_tests_arriving_with_a_target_merge_are_not_implementer_additions(tmp_path, capsys):
    """The Lead's single target sync may bring other delivered tests; only the implementer's additions break the contract."""
    git(tmp_path, "init", "-b", "main")
    git(tmp_path, "config", "user.name", "Test")
    git(tmp_path, "config", "user.email", "test@example.com")
    tests = tmp_path / "tests/unit"
    tests.mkdir(parents=True)
    (tests / "test_existing.py").write_text('def test_existing():\n    """Existing behaviour."""\n    assert True\n')
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-m", "base")
    base = git(tmp_path, "rev-parse", "HEAD")
    git(tmp_path, "switch", "-c", "work")
    stub = tests / "test_value.py"
    stub.write_text('def test_value():\n    """The value is one."""\n    assert False, "stub"\n')
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-m", "criteria")
    anchor = git(tmp_path, "rev-parse", "HEAD")
    stub.write_text('def test_value():\n    """The value is one."""\n    assert 1 == 1\n')
    git(tmp_path, "commit", "-am", "implement")
    git(tmp_path, "switch", "main")
    (tests / "test_prerequisite.py").write_text('def test_prerequisite():\n    """Delivered elsewhere."""\n    assert True\n')
    (tests / "test_existing.py").write_text('def test_existing():\n    """Existing behaviour, revised on the target."""\n    assert True\n')
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-m", "prerequisite delivered")
    git(tmp_path, "switch", "work")
    git(tmp_path, "merge", "--no-edit", "main")
    arguments = ["check", "--root", str(tmp_path), "--base", base, "--anchor", anchor]
    assert ship_stubs.main(arguments) == 0
    (tests / "test_prerequisite.py").write_text('def test_prerequisite():\n    """Delivered elsewhere."""\n    assert True\n\n\ndef test_sneaked():\n    assert True\n')
    assert ship_stubs.main(arguments) == 1  # The implementer still cannot add tests beside merged ones.
    capsys.readouterr()
