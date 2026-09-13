"""Refresh one or more mirrored documentation reference sets."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


REFERENCE_PATTERN = re.compile(
    r"\[([^\]]+)\]\(\./([^)]+)\)\s*\n\s*-\s*Source:\s*(https://\S+)",
    re.MULTILINE,
)

REFERENCE_SETS = {
    "CLAUDE-REFERENCES": (
        ("settings.md", "settings.md", "https://code.claude.com/docs/en/settings.md"),
        ("skills.md", "skills.md", "https://code.claude.com/docs/en/skills.md"),
        ("hooks.md", "hooks.md", "https://code.claude.com/docs/en/hooks.md"),
        (
            "tools-reference.md",
            "tools-reference.md",
            "https://code.claude.com/docs/en/tools-reference.md",
        ),
    ),
    "CHATGPT-REFERENCES": (
        ("build-skills.md", "build-skills.md", "https://learn.chatgpt.com/docs/build-skills.md"),
        ("hooks.md", "hooks.md", "https://learn.chatgpt.com/docs/hooks.md"),
        (
            "developer-settings.md",
            "developer-settings.md",
            "https://learn.chatgpt.com/docs/developer-settings.md?surface=cli",
        ),
        (
            "developer-commands.md",
            "developer-commands.md",
            "https://learn.chatgpt.com/docs/developer-commands.md?surface=cli",
        ),
        ("agents-md.md", "agents-md.md", "https://learn.chatgpt.com/docs/agent-configuration/agents-md.md"),
        ("subagents.md", "subagents.md", "https://learn.chatgpt.com/docs/agent-configuration/subagents.md"),
        ("config-basic.md", "config-basic.md", "https://learn.chatgpt.com/docs/config-file/config-basic.md"),
        (
            "config-reference.md",
            "config-reference.md",
            "https://learn.chatgpt.com/docs/config-file/config-reference.md",
        ),
        ("import.md", "import.md", "https://learn.chatgpt.com/docs/import.md"),
        ("build-plugins.md", "build-plugins.md", "https://learn.chatgpt.com/docs/build-plugins.md"),
        ("chatgpt-cli.md", "chatgpt-cli.md", "https://learn.chatgpt.com/docs/codex/cli.md"),
    ),
}


class ReferenceUpdateError(Exception):
    """A reference index is invalid or one of its sources could not be fetched."""


def fetch_text(url: str) -> str:
    request = Request(url, headers={"User-Agent": "harness-reference-updater/1"})
    with urlopen(request, timeout=30) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        return response.read().decode(charset)


def update_reference_set(root: Path) -> int:
    readme_path = root / "README.md"
    if readme_path.is_file():
        matches = REFERENCE_PATTERN.findall(readme_path.read_text(encoding="utf-8"))
        if not matches:
            raise ReferenceUpdateError(f"no references found in {readme_path}")
    else:
        matches = REFERENCE_SETS.get(root.name)
        if matches is None:
            raise ReferenceUpdateError(f"unknown reference set without an index: {root}")

    failures: list[str] = []
    updated = 0
    for display_name, local_file, url in matches:
        print(f"Fetching {display_name}: {url}")
        try:
            text = fetch_text(url)
            if not text.strip():
                raise ReferenceUpdateError("empty response")
            output_file = root / local_file
            output_file.parent.mkdir(parents=True, exist_ok=True)
            output_file.write_text(text, encoding="utf-8")
            print(f"Saved {output_file}")
            updated += 1
        except (HTTPError, URLError, OSError, UnicodeError, ReferenceUpdateError) as exc:
            failures.append(f"{display_name} ({url}): {exc}")

    if failures:
        detail = "\n".join(f"- {failure}" for failure in failures)
        raise ReferenceUpdateError(f"failed to update {root}:\n{detail}")

    print(f"Updated {updated} files in {root}.")
    return updated


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Refresh mirrored documentation reference sets."
    )
    parser.add_argument("roots", nargs="+", type=Path)
    args = parser.parse_args(argv)

    try:
        total = sum(update_reference_set(root) for root in args.roots)
    except ReferenceUpdateError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(f"Updated {total} reference files total.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
