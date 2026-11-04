"""Reject staged copies of credentials held in this checkout's private config."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys


SENSITIVE_ENV = re.compile(r"(?:SECRET|TOKEN|PASSWORD|API_KEY|GRILL_CODE)$", re.I)


def git(root: Path, *args: str) -> bytes:
    return subprocess.run(
        ["git", "-C", str(root), *args], check=True, capture_output=True,
    ).stdout


def private_values(root: Path) -> set[str]:
    values: set[str] = set()
    # Production settings stay local. Never include example/development codes,
    # whose deliberately public values are also used by isolated test fixtures.
    paths = list(root.glob(".env.production*"))
    paths.extend((root / "apps").glob("*/.env.production*"))
    for path in paths:
        if not path.is_file():
            continue
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            key, separator, value = line.strip().partition("=")
            if separator and SENSITIVE_ENV.search(key.removeprefix("export ")):
                value = value.strip().strip("\"'")
                if value:
                    values.add(value)
    config = root / ".harness/config.local.json"
    if config.is_file():
        data = json.loads(config.read_text(encoding="utf-8-sig"))
        code = data.get("grill", {}).get("code")
        if isinstance(code, str) and code:
            values.add(code)
    return values


def contains_credential(text: str, value: str) -> bool:
    if re.fullmatch(r"\d{4}", value):
        # Numeric substrings in checksums, ports, and documentation are unrelated.
        # Match code assignments and bearer authentication, including quoted JSON.
        return bool(re.search(
            r"(?i)(?:(?:\b(?:HARNESS_GRILL_CODE|code)[\"']?\s*[:=]\s*[\"']?|\bBearer\s+)"
            + re.escape(value) + r"(?![\w])|[\"']" + re.escape(value) + r"[\"'])",
            text,
        ))
    if len(value) < 8:
        return False
    return value in text or json.dumps(value, ensure_ascii=True)[1:-1] in text


def check(root: Path, *, staged: bool) -> list[str]:
    values = private_values(root)
    if not values:
        print("No local production credentials available for comparison.")
        return []
    paths = git(root, "diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z") if staged else git(
        root, "ls-files", "--cached", "--others", "--exclude-standard", "-z",
    )
    findings = []
    for raw in paths.split(b"\0"):
        if not raw:
            continue
        name = raw.decode("utf-8", errors="surrogateescape")
        # Reading the index catches staged secrets even after the working file is fixed.
        payload = git(root, "show", ":" + name) if staged else (root / name).read_bytes()
        if b"\0" in payload:
            continue
        text = payload.decode("utf-8", errors="replace")
        if any(contains_credential(text, value) for value in values):
            findings.append(name)
    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staged", action="store_true", help="Check the Git index before committing")
    parser.add_argument("--install-hook", action="store_true", help="Enable the local pre-commit check")
    args = parser.parse_args()
    root = Path(git(Path.cwd(), "rev-parse", "--show-toplevel").decode().strip())
    try:
        if args.install_hook:
            current = subprocess.run(
                ["git", "-C", str(root), "config", "--get", "core.hooksPath"],
                capture_output=True, text=True,
            ).stdout.strip()
            legacy = Path(git(root, "rev-parse", "--git-path", "hooks/pre-commit").decode().strip())
            if not legacy.is_absolute():
                legacy = root / legacy
            if current not in {"", ".githooks"} or (not current and legacy.exists()):
                print("An existing Git hook configuration needs manual integration; it was preserved.", file=sys.stderr)
                return 2
            hook = root / ".githooks/pre-commit"
            hook.chmod(hook.stat().st_mode | 0o111)
            git(root, "config", "--local", "core.hooksPath", ".githooks")
            print("Local pre-commit credential check enabled.")
            return 0
        findings = check(root, staged=args.staged)
    except (OSError, ValueError, subprocess.CalledProcessError):
        print("Could not complete local credential check; commit blocked. Check private config and Git state.", file=sys.stderr)
        return 2
    if findings:
        print("Local production credential found; remove it from these files before committing:", file=sys.stderr)
        for name in findings:
            print("  " + name, file=sys.stderr)
        return 1
    print("Local credential check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
