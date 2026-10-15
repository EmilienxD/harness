"""Command-line interface for local web search and page fetching."""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
import time

# Pages up to this size print whole; longer ones print this much and save the rest.
INLINE_CHARS = 10_000
OUTLINE_LIMIT = 40
SAVED_PAGE_TTL = 24 * 3600

DESCRIPTION = """\
Local web search and page fetching.

  web-toolkit search "<query>"   titles, URLs, and snippets; site: and -site: filter domains
  web-toolkit fetch <url>        the page as Markdown; long pages are saved to a file
"""


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="web-toolkit", description=DESCRIPTION, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    commands = parser.add_subparsers(dest="command", required=True, metavar="{search,fetch}")
    search = commands.add_parser("search", help="search the web")
    search.add_argument("query", help="search terms; quote multi-word queries")
    fetch = commands.add_parser("fetch", help="fetch a page as Markdown or text")
    fetch.add_argument("url", help="the URL to fetch")
    return parser


def _run_search(args: argparse.Namespace) -> int:
    from web_toolkit import search

    results, failures = search.search(args.query)
    if not results:
        reasons = ", ".join(f"{name}: {status}" for name, status in failures)
        print(f"error: no results ({reasons})", file=sys.stderr)
        return 1
    blocks = []
    for index, result in enumerate(results, 1):
        lines = [f"{index}. {result.title}", f"   {result.url}"]
        if result.snippet:
            lines.append(f"   {result.snippet}")
        blocks.append("\n".join(lines))
    print("\n\n".join(blocks))
    return 0


def _save(url: str, text: str) -> str:
    from web_toolkit.browser import state_dir

    pages = state_dir() / "pages"
    pages.mkdir(parents=True, exist_ok=True)
    cutoff = time.time() - SAVED_PAGE_TTL
    for old in pages.glob("*.md"):
        try:
            if old.stat().st_mtime < cutoff:
                old.unlink()
        except OSError:
            pass
    path = pages / f"{hashlib.sha256(url.encode()).hexdigest()[:16]}.md"
    path.write_text(text, encoding="utf-8", newline="\n")
    return str(path)


def _outline(lines: list[str], start: int) -> list[str]:
    """Markdown headings from line ``start`` on, with their 1-based line numbers."""
    headings = []
    fence = None
    for number, line in enumerate(lines, 1):
        if found := re.match(r"\s*(`{3,}|~{3,})", line):
            marker = found.group(1)
            if fence is None:
                fence = marker
            elif marker.startswith(fence):
                fence = None
            continue
        if fence is None and number > start and re.match(r"#{1,6} \S", line):
            # Heading anchors and permalinks only add URLs to the outline.
            heading = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", line).replace("¶", "").strip()
            headings.append(f"  {number}: {heading}")
    if len(headings) > OUTLINE_LIMIT:
        headings = [*headings[:OUTLINE_LIMIT], f"  ... {len(headings) - OUTLINE_LIMIT} more headings"]
    return headings


def _run_fetch(args: argparse.Namespace) -> int:
    from web_toolkit.fetch import fetch

    page = fetch(args.url)
    header = [f"URL: {page.url}"]
    if page.title:
        header.append(f"Title: {page.title}")
    if page.status is not None and not 200 <= page.status < 300:
        header.append(f"Status: {page.status}")
    if page.note:
        header.append(f"Note: {page.note}")
    text = page.text.replace("\r\n", "\n")
    body = text
    if len(text) > INLINE_CHARS:
        cut = text.rfind("\n", 0, INLINE_CHARS)
        cut = cut if cut > 0 else INLINE_CHARS
        lines = text.split("\n")
        shown = text.count("\n", 0, cut) + 1
        header.append(f"Full text: {_save(page.url, text)} ({len(lines)} lines; lines 1-{shown} shown below)")
        body = text[:cut].rstrip("\n")
        if outline := _outline(lines, shown):
            body += "\n\n[Truncated. Later headings by line number in the full text:]\n" + "\n".join(outline)
        else:
            body += "\n\n[Truncated. Read the full text for the rest.]"
    print("\n".join(header) + "\n\n" + body, flush=True)
    if page.status is not None and page.status >= 400:
        # The error page is printed above: it often explains the failure.
        print(f"error: HTTP {page.status}", file=sys.stderr)
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        # Agents read UTF-8; Windows pipes otherwise use the legacy code page.
        stream.reconfigure(encoding="utf-8", errors="replace")
    args = _parser().parse_args(argv)
    from web_toolkit.browser import BrowserError
    from web_toolkit.fetch import FetchError

    try:
        return _run_search(args) if args.command == "search" else _run_fetch(args)
    except (BrowserError, FetchError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
