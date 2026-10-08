"""Ship the canonical toolkit in both standalone runtime distributions."""

from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class ToolkitBuildHook(BuildHookInterface):
    def initialize(self, version, build_data):
        source = Path(self.root).parent / "subagents-toolkit" / "SKILL.md"
        if not source.is_file():
            # A source distribution already contains the toolkit under src/.
            return
        destination = "subagents_runtime/resources/subagents-toolkit.md"
        if self.target_name == "sdist":
            destination = "src/" + destination
        build_data["force_include"][str(source)] = destination
        registry = source.with_name("builtin-tasks.yaml")
        build_data["force_include"][str(registry)] = Path(destination).with_name("builtin-tasks.yaml").as_posix()
