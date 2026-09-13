#!/usr/bin/env python3
"""
Remove decorative comment-separator lines from a codebase.

Detects and deletes lines like:

    # --- wait hook -------------------------------------------------------------
    # --------------------------------------------------------------------------

A comment line is treated as "decorative" when its content (after the
comment marker is stripped) is either:

  1. A run of MIN_DASHES or more dashes and nothing else, or
  2. A short title flanked by dashes, where the leading and/or trailing
     dash run is MIN_DASHES or more dashes long.

Only lines that consist ENTIRELY of such a comment are removed (the whole
line, including its line break). Inline trailing comments on code lines
are never touched. Markdown files (.md, .markdown, .mdx) are always
skipped, no matter what.
"""

from __future__ import annotations

import argparse
import os
import re

MIN_DASHES = 8  # minimum length of a dash run to count as a separator; no upper limit

# Directories that are never walked into.
EXCLUDED_DIRS = {
    ".git", "node_modules", "__pycache__", "venv", ".venv", "env",
    "dist", "build", ".next", "target", "vendor", ".idea", ".vscode",
    "egg-info", ".mypy_cache", ".pytest_cache",
}

# Files that must never be touched, no matter what.
MARKDOWN_EXTENSIONS = {".md", ".markdown", ".mdx"}

# Comment "kinds" -> (prefix, suffix or None). suffix None means the
# comment runs to the end of the line (a plain line comment).
COMMENT_KINDS = {
    "hash": ("#", None),
    "slash": ("//", None),
    "block": ("/*", "*/"),
    "html": ("<!--", "-->"),
    "dashdash": ("--", None),
    "semicolon": (";", None),
    "percent": ("%", None),
    "apostrophe": ("'", None),
}

# Extension -> list of comment kinds that apply to it, in priority order.
# Extend this freely for any language not yet listed.
LANGUAGE_COMMENT_STYLES: dict[str, list[str]] = {
    # Python (top priority)
    ".py": ["hash"], ".pyw": ["hash"], ".pyi": ["hash"],
    # TypeScript / JavaScript / React (top priority)
    ".ts": ["slash", "block"], ".tsx": ["slash", "block"],
    ".js": ["slash", "block"], ".jsx": ["slash", "block"],
    ".mjs": ["slash", "block"], ".cjs": ["slash", "block"],
    # HTML (top priority)
    ".html": ["html"], ".htm": ["html"], ".xml": ["html"],
    ".vue": ["html", "slash", "block"], ".svelte": ["html", "slash", "block"],
    # CSS (top priority)
    ".css": ["block"], ".scss": ["slash", "block"], ".less": ["slash", "block"],
    # Everything else, so all common languages are covered too
    ".sh": ["hash"], ".bash": ["hash"], ".zsh": ["hash"], ".fish": ["hash"],
    ".rb": ["hash"], ".pl": ["hash"], ".r": ["hash"],
    ".yml": ["hash"], ".yaml": ["hash"], ".toml": ["hash"],
    ".ini": ["hash"], ".cfg": ["hash"], ".ps1": ["hash"], ".tf": ["hash"],
    ".java": ["slash", "block"], ".c": ["slash", "block"], ".h": ["slash", "block"],
    ".cpp": ["slash", "block"], ".cc": ["slash", "block"], ".hpp": ["slash", "block"],
    ".cs": ["slash", "block"], ".go": ["slash", "block"], ".rs": ["slash", "block"],
    ".swift": ["slash", "block"], ".kt": ["slash", "block"], ".kts": ["slash", "block"],
    ".scala": ["slash", "block"], ".dart": ["slash", "block"],
    ".php": ["slash", "block", "hash"],
    ".sql": ["dashdash"], ".lua": ["dashdash"],
    ".lisp": ["semicolon"], ".clj": ["semicolon"], ".el": ["semicolon"],
    ".tex": ["percent"],
    ".vb": ["apostrophe"], ".bas": ["apostrophe"],
}

# Extensionless filenames that still have a known comment style.
FILENAME_COMMENT_STYLES: dict[str, list[str]] = {
    "Dockerfile": ["hash"], "Makefile": ["hash"], "Rakefile": ["hash"],
    "Gemfile": ["hash"], "CMakeLists.txt": ["hash"],
}


def get_comment_kinds(filename: str) -> list[str]:
    ext = os.path.splitext(filename)[1].lower()
    if ext in MARKDOWN_EXTENSIONS:
        return []
    if ext in LANGUAGE_COMMENT_STYLES:
        return LANGUAGE_COMMENT_STYLES[ext]
    return FILENAME_COMMENT_STYLES.get(filename, [])


def build_matchers(kinds: list[str]) -> list[re.Pattern]:
    """One regex per comment kind, capturing the comment's inner content."""
    matchers = []
    for kind in kinds:
        prefix, suffix = COMMENT_KINDS[kind]
        p = re.escape(prefix)
        if suffix is None:
            pattern = rf"^\s*{p}(.*)$"
        else:
            s = re.escape(suffix)
            pattern = rf"^\s*{p}(.*?){s}\s*$"
        matchers.append(re.compile(pattern))
    return matchers


def is_decorative(content: str) -> bool:
    content = content.strip()
    if not content:
        return False

    # Case 1: the whole comment is nothing but dashes.
    if re.fullmatch(r"-{%d,}" % MIN_DASHES, content):
        return True

    # Case 2: a title flanked by dashes, e.g. "--- wait hook ------------".
    leading = re.match(r"^-{2,}(?=\s)", content)
    trailing = re.search(r"(?<=\s)-{2,}$", content)
    if leading and trailing:
        lead_len = leading.end() - leading.start()
        trail_len = trailing.end() - trailing.start()
        if lead_len >= MIN_DASHES or trail_len >= MIN_DASHES:
            middle = content[leading.end():trailing.start()].strip()
            return bool(middle)

    return False


def line_is_decorative_comment(line: str, matchers: list[re.Pattern]) -> bool:
    stripped = line.rstrip("\r\n")
    for matcher in matchers:
        m = matcher.match(stripped)
        if m and is_decorative(m.group(1)):
            return True
    return False


def process_file(path: str, kinds: list[str], dry_run: bool, verbose: bool) -> int:
    matchers = build_matchers(kinds)
    try:
        with open(path, "r", encoding="utf-8", newline="") as f:
            lines = f.readlines()
    except (UnicodeDecodeError, OSError):
        return 0

    kept = []
    removed = 0
    for line in lines:
        if line_is_decorative_comment(line, matchers):
            removed += 1
            if verbose:
                print(f"  removed: {path}: {line.rstrip(chr(10)).rstrip(chr(13))!r}")
        else:
            kept.append(line)

    if removed and not dry_run:
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.writelines(kept)

    return removed


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("path", nargs="?", default=".", help="Root directory to process (default: current directory)")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be removed without modifying files")
    parser.add_argument("-v", "--verbose", action="store_true", help="Print every removed line")
    args = parser.parse_args()

    total_files = 0
    total_lines = 0

    for root, dirs, files in os.walk(args.path):
        dirs[:] = [d for d in dirs if d not in EXCLUDED_DIRS and not d.startswith(".")]
        for name in files:
            kinds = get_comment_kinds(name)
            if not kinds:
                continue
            path = os.path.join(root, name)
            removed = process_file(path, kinds, args.dry_run, args.verbose)
            if removed:
                total_files += 1
                total_lines += removed
                verb = "Would remove" if args.dry_run else "Removed"
                print(f"{verb} {removed} line(s) from {path}")

    verb_mod = "Would modify" if args.dry_run else "Modified"
    verb_rem = "would remove" if args.dry_run else "removed"
    print(f"\n{verb_mod} {total_files} file(s), {verb_rem} {total_lines} line(s) total.")


if __name__ == "__main__":
    main()
