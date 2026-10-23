"""Acquire upstream skills through their native installer without vendoring them."""

from __future__ import annotations

import hashlib
import os
import subprocess
import tempfile
from dataclasses import replace
from pathlib import Path

from harness_cli.host_actions import _npm_command
from harness_cli.manifest import FileSpec, Tool


def acquire(tool: Tool, directory: Path) -> Tool:
    """Stage native skill copies; normal Harness receipts own the final files."""
    specs = list(tool.files)
    digest = hashlib.sha256()
    for index, action in enumerate(tool.actions):
        if action.type != "upstream-skill":
            continue
        source, skill = str(action.data["source"]), str(action.data["skill"])
        staging = directory / str(index)
        staging.mkdir(parents=True)
        # npm exec also works on Windows without invoking an npx .cmd shell.
        command = [
            *_npm_command(), "exec", "--yes", "--package=skills", "--",
            "skills", "add", source, "--skill", skill,
            "--agent", "claude-code", "--copy", "--yes",
        ]
        result = subprocess.run(
            command, cwd=staging, capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=300,
            env={**os.environ, "DISABLE_TELEMETRY": "1"},
        )
        if result.returncode:
            raise RuntimeError((result.stderr or result.stdout).strip() or f"could not install {source}@{skill}")
        payload = staging / ".claude" / "skills" / skill
        if not (payload / "SKILL.md").is_file():
            raise RuntimeError(f"upstream installer did not produce {skill}/SKILL.md")
        spec = FileSpec(payload.relative_to(directory).as_posix(), skill, "skills")
        specs.append(spec)
        staged = replace(tool, root=directory, files=(spec,))
        for file in staged.expand():
            digest.update(file.dest.encode("utf-8") + b"\0")
            digest.update(hashlib.sha256(file.source.read_bytes()).digest())
    # Include upstream content in receipt identity so an explicit upgrade can
    # follow upstream even when the bridge manifest has not changed.
    return replace(
        tool, root=directory, files=tuple(specs),
        version=f"{tool.version}+{digest.hexdigest()[:16]}",
        actions=tuple(action for action in tool.actions if action.type != "upstream-skill"),
    )


class Staging:
    def __init__(self) -> None:
        self.directory = tempfile.TemporaryDirectory(prefix="harness-upstream-skills-")
        self.tools: dict[str, Tool] = {}

    def acquire(self, tool: Tool) -> Tool:
        if tool.name not in self.tools:
            directory = Path(tempfile.mkdtemp(prefix=f"{tool.name}-", dir=self.directory.name))
            self.tools[tool.name] = acquire(tool, directory)
        return self.tools[tool.name]
