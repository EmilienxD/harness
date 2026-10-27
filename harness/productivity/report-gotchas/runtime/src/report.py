"""Run the bundled reporter without installing a Python package."""

import sys

sys.dont_write_bytecode = True

from report_gotchas.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
