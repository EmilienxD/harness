"""Adapt file references for providers without Claude's @ expansion."""

from __future__ import annotations

import re
from os import sep
from pathlib import Path


FILE_REFERENCE = re.compile(
    r'''(?<![\w@/\\])@(?P<reference>"[^"\r\n]+"|'[^'\r\n]+'|`[^`\r\n]+`|[^\s`"'<>()[\]{},;!?]+)'''
)


def normalize_file_references(prompt: str, cwd: Path) -> str:
    """Remove file-reference markers and use the host's path separators.

    Keep surrounding quotes, Markdown, punctuation, and unrelated @ text.
    Extensionless references are paths when they exist in the child's directory.
    """
    def substitute(match: re.Match[str]) -> str:
        reference = match.group("reference")
        quoted = reference[0] in "\"'`"
        path = reference[1:-1] if quoted else reference.rstrip(".:")
        if not path or "@" in path or "://" in path:
            return match.group()
        if not any(character in path for character in "/\\."):
            try:
                if not (cwd / path).exists():
                    return match.group()
            except (OSError, ValueError):
                return match.group()
        normalized = path.replace("\\", "/").replace("/", sep)
        if quoted:
            return reference[0] + normalized + reference[-1]
        return normalized + reference[len(path):]

    return FILE_REFERENCE.sub(substitute, prompt)
