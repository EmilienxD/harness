#!/usr/bin/env python3
"""Maintain the websearch skill's curated source index."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from pathlib import Path


SOURCES_PATH = Path(__file__).with_name("sources.json")


def load_sources() -> dict[str, str]:
    try:
        data = json.loads(SOURCES_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    if not isinstance(data, dict) or not all(
        isinstance(title, str) and isinstance(source, str)
        for title, source in data.items()
    ):
        raise ValueError(f"{SOURCES_PATH.name} must contain a JSON object of title/source strings")
    return data


def save_sources(sources: dict[str, str]) -> None:
    content = json.dumps(dict(sorted(sources.items())), indent=2, ensure_ascii=False) + "\n"
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            dir=SOURCES_PATH.parent,
            encoding="utf-8",
            delete=False,
        ) as temporary:
            temporary.write(content)
            temporary_path = Path(temporary.name)
        os.replace(temporary_path, SOURCES_PATH)
        temporary_path = None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    add_parser = subparsers.add_parser("add", help="add or update a useful source")
    add_parser.add_argument("title")
    add_parser.add_argument("source")

    search_parser = subparsers.add_parser("search", help="search saved titles and sources")
    search_parser.add_argument("query")

    args = parser.parse_args()
    try:
        sources = load_sources()
    except (OSError, json.JSONDecodeError, ValueError) as error:
        parser.error(str(error))

    if args.command == "add":
        title = args.title.strip()
        source = args.source.strip()
        if not title or not source:
            parser.error("title and source must not be empty")
        sources[title] = source
        try:
            save_sources(sources)
        except OSError as error:
            parser.error(str(error))
        print(f"{title}: {source}")
        return 0

    query = args.query.casefold()
    matches = [
        (title, source)
        for title, source in sorted(sources.items())
        if query in title.casefold() or query in source.casefold()
    ]
    if not matches:
        print("No sources found.")
    for title, source in matches:
        print(f"{title}: {source}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
