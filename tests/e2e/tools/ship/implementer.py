"""Deterministic implementer verification commands, run through the provider's shell tool."""
from pathlib import Path
import json
import subprocess
import sys

command, evidence, target = sys.argv[1:4]
evidence = Path(evidence)
evidence.parent.mkdir(parents=True, exist_ok=True)
if command == "test":
    result = subprocess.run([sys.executable, "-m", "pytest", target, "-q", "-p", "no:cacheprovider"], capture_output=True, text=True)
elif command == "workflow":
    result = subprocess.run([sys.executable, target], capture_output=True, text=True)
elif command == "status":
    fixture = json.loads((Path(__file__).resolve().parent / "fixture.json").read_text(encoding="utf-8"))
    result = subprocess.run([*fixture["commands"]["test-workflows"], "--json", "status"], capture_output=True, text=True)
else:
    raise SystemExit(f"unknown implementer command {command}")
evidence.write_text(result.stdout + result.stderr, encoding="utf-8")
# A failing check is a reportable result, not a tool failure.
print(f"exit={result.returncode}\nHARNESS_SHIP_STEP_OK")
