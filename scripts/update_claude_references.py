"""Backward-compatible entry point for refreshing Claude references."""

from update_references import main


if __name__ == "__main__":
    raise SystemExit(main(["docs/CLAUDE-REFERENCES"]))
