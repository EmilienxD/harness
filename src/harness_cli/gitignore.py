"""Idempotent, reversible management of the `.gitignore` entries a tool needs.

Same contract as `settings_merge`: installing twice is a no-op, and uninstalling
removes exactly what installing added and nothing the user wrote themselves.

A tool's patterns live inside a fenced block tagged with the tool name. That
fence is not decoration — `.gitignore` has no trailing-comment syntax, so
`commit-ai.key  # harness` would make `# harness` part of the pattern and
silently stop matching. Marking the block is the only place a marker can go.
"""

from __future__ import annotations

from collections.abc import Iterable

BEGIN = "# >>> harness:{name} >>>"
END = "# <<< harness:{name} <<<"


def _fence(name: str) -> tuple[str, str]:
    return BEGIN.format(name=name), END.format(name=name)


def _join(lines: list[str]) -> str:
    return "\n".join(lines) + "\n" if lines else ""


def existing_patterns(text: str) -> set[str]:
    """Every active pattern in the file, whoever wrote it."""
    return {
        line.strip()
        for line in text.splitlines()
        if line.strip() and not line.strip().startswith("#")
    }


def block_patterns(text: str, name: str) -> list[str]:
    """Return active patterns inside `name`'s complete fenced block."""
    begin, end = _fence(name)
    lines = text.splitlines()
    start = next((i for i, line in enumerate(lines) if line.strip() == begin), None)
    if start is None:
        return []
    stop = next((i for i in range(start + 1, len(lines)) if lines[i].strip() == end), None)
    if stop is None:
        return []
    return [
        line.strip()
        for line in lines[start + 1 : stop]
        if line.strip() and not line.strip().startswith("#")
    ]


def strip_block(text: str, name: str) -> str:
    """Remove `name`'s fenced block, leaving everything else byte-identical."""
    begin, end = _fence(name)
    lines = text.splitlines()

    start = next((i for i, line in enumerate(lines) if line.strip() == begin), None)
    if start is None:
        return text

    stop = next((i for i in range(start + 1, len(lines)) if lines[i].strip() == end), None)
    if stop is None:
        # Hand-edited file with the closing fence deleted. Drop the marker only:
        # swallowing everything to EOF would eat rules we never owned.
        del lines[start]
    else:
        del lines[start : stop + 1]

    # Also take back the blank separator line we added ahead of the block.
    if start > 0 and not lines[start - 1].strip():
        del lines[start - 1]

    return _join(lines)


def apply(text: str, name: str, patterns: Iterable[str]) -> str:
    """Return `text` with `name`'s block holding exactly `patterns`.

    Patterns the file already lists outside our block are skipped rather than
    duplicated — the user's own line is theirs to keep, and uninstalling must
    not delete it.
    """
    base = strip_block(text, name)
    already = existing_patterns(base)
    wanted = [p for p in patterns if p not in already]
    if not wanted:
        return base

    begin, end = _fence(name)
    lines = base.splitlines()
    if lines and lines[-1].strip():
        lines.append("")
    return _join([*lines, begin, *wanted, end])


def remove(text: str, name: str) -> str:
    """Back out whatever `apply` added for `name`."""
    return strip_block(text, name)
