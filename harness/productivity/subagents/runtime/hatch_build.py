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
        package = Path(self.root).parent
        prefix = "src/" if self.target_name == "sdist" else ""
        root = prefix + "subagents_runtime/resources/reply-support/"
        for relative in (
            "reply-to-agent/SKILL.md", "reply-to-agent/chatgpt/openai.yaml",
            "reply-to-agent-with-previous-message/SKILL.md",
            "reply-to-agent-with-previous-message/chatgpt/openai.yaml",
            "claude/settings.fragment.json", "chatgpt/hooks.fragment.json",
            "pi/extension.ts",
        ):
            build_data["force_include"][str(package / relative)] = root + relative
        transport = package.parents[1] / "internal/pi-transport/transport.ts"
        build_data["force_include"][str(transport)] = root + "pi/transport.ts"
