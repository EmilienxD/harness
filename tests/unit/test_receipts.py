from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from harness_cli.receipts import installation_lock


ROOT = Path(__file__).parents[2]


def test_installation_lock_serializes_other_processes(tmp_path):
    receipt = tmp_path / "receipts.json"
    child_code = """
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from harness_cli.receipts import installation_lock
print("ready", flush=True)
with installation_lock(Path(sys.argv[2]), timeout=5):
    print("acquired", flush=True)
"""

    with installation_lock(receipt, timeout=5):
        child = subprocess.Popen(
            [sys.executable, "-c", child_code, str(ROOT / "src"), str(receipt)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        assert child.stdout is not None
        assert child.stdout.readline().strip() == "ready"
        assert child.poll() is None

    stdout, stderr = child.communicate(timeout=10)
    assert child.returncode == 0, stderr
    assert stdout.strip() == "acquired"


def test_mutating_cli_waits_for_the_installer_lock(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    state = tmp_path / "state"
    receipt = state / "receipts.json"
    child_code = """
import sys
sys.path.insert(0, sys.argv[1])
from harness_cli.cli import main
print("ready", flush=True)
raise SystemExit(main(sys.argv[2:]))
"""
    env = {**os.environ, "HARNESS_STATE_DIR": str(state)}

    with installation_lock(receipt, timeout=5):
        child = subprocess.Popen(
            [
                sys.executable,
                "-c",
                child_code,
                str(ROOT / "src"),
                "install",
                "caveman",
                "--platform",
                "claude",
                "--root",
                str(project),
                "--json",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )
        assert child.stdout is not None
        assert child.stdout.readline().strip() == "ready"
        assert child.poll() is None

    stdout, stderr = child.communicate(timeout=10)
    assert child.returncode == 0, stderr
    assert json.loads(stdout)["ok"] is True
    assert (project / ".claude" / "skills" / "caveman" / "SKILL.md").is_file()
