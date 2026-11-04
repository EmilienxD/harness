"""Select Harness CI jobs from GitHub events, without installing dependencies."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess


JOBS = ("python", "distribution", "shared_e2e")
DEPENDENCIES = {"pyproject.toml", "uv.lock", ".gitignore"}
CI_INPUTS = {
    ".github/workflows/ci.yml",
    "scripts/ci_changes.py",
    "tests/unit/test_ci_changes.py",
}


def select_jobs(paths: list[str] | None) -> dict[str, bool]:
    # Missing history and manual runs select every applicable check.
    if paths is None or any(path in CI_INPUTS for path in paths):
        return dict.fromkeys(JOBS, True)

    return {
        "python": any(
            path in DEPENDENCIES
            or path.startswith(("src/", "harness/", "scripts/", "apps/aboard/assets/runtime/"))
            or (path.startswith("tests/") and not path.startswith("tests/e2e/"))
            for path in paths
        ),
        # The source distribution includes tests and all shipped skill Markdown.
        "distribution": any(
            path in DEPENDENCIES | {"README.md", "LICENSE"}
            or path.startswith(("src/", "harness/", "tests/"))
            for path in paths
        ),
        "shared_e2e": any(
            path in DEPENDENCIES
            or path.startswith(("src/", "harness/", "tests/e2e/"))
            for path in paths
        ),
    }


def changed_paths(event_name: str, event: dict, root: Path) -> list[str] | None:
    if event_name == "pull_request":
        base = event["pull_request"]["base"]["sha"]
        head = event["pull_request"]["head"]["sha"]
        separator = "..."  # Ignore changes made only on the PR's base branch.
    elif event_name == "push":
        base, head = event["before"], event["after"]
        separator = ".."
    else:
        return None

    if any(not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", sha) or set(sha) == {"0"} for sha in (base, head)):
        return None

    try:
        diff = subprocess.run(
            # Include both sides of a rename so moving a payload into docs still runs CI.
            ["git", "diff", "--name-only", "--no-renames", "-z", f"{base}{separator}{head}", "--"],
            cwd=root,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=30,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        print("::warning::Could not compare commits; running all Harness checks.")
        return None
    return [os.fsdecode(path) for path in diff.stdout.split(b"\0") if path]


def python_matrix(full: bool) -> dict:
    if full:
        return {"os": ["ubuntu-latest", "windows-latest"], "python": ["3.11", "3.13"]}
    return {"include": [
        {"os": "ubuntu-latest", "python": "3.11"},
    ]}


def main() -> None:
    event_name = os.environ["GITHUB_EVENT_NAME"]
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
    jobs = select_jobs(changed_paths(event_name, event, Path.cwd()))
    matrix = python_matrix(event.get("inputs", {}).get("full") in {True, "true"})
    with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as output:
        for name, enabled in jobs.items():
            output.write(f"{name}={str(enabled).lower()}\n")
        output.write("python_matrix=" + json.dumps(matrix, separators=(",", ":")) + "\n")
    print("Selected checks: " + json.dumps(jobs))


if __name__ == "__main__":
    main()
