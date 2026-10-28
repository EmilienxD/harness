"""Enable this conversation's inbox through the installed Harness runtime."""

import subprocess
import sys


if __name__ == "__main__":
    try:
        result = subprocess.run(["harness-subagents-hook", "--enable-inbox"], check=False)
    except OSError as exc:
        print(f"Cannot enable the subagents inbox: {exc}", file=sys.stderr)
        raise SystemExit(1)
    raise SystemExit(result.returncode)
