"""Platform adapters for Claude Code and ChatGPT install layouts.

The rest of the installer deals in logical destination roots and native JSON
fragments.  This module is the only place that knows where a platform stores
those things or which placeholders it supports.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

from harness_cli import settings_merge


class Platform(str, Enum):
    CLAUDE = "claude"
    CHATGPT = "chatgpt"

    @classmethod
    def parse(cls, value: "Platform | str") -> "Platform":
        if isinstance(value, cls):
            return value
        try:
            return cls(value)
        except ValueError as exc:
            raise ValueError(f"unknown platform '{value}'") from exc


DESTINATION_ROOTS = frozenset({"platform", "skills", "hooks"})


@dataclass(frozen=True)
class PlatformAdapter:
    platform: Platform
    product_name: str
    project_platform_dir: str
    user_platform_dir: str
    project_skills_dir: str
    user_skills_dir: str
    config_name: str
    supports_local_config: bool
    restart_guidance: str
    legacy_artifacts: tuple[str, ...] = ()

    def platform_root(self, scope_root: Path, is_user: bool) -> Path:
        return scope_root / (self.user_platform_dir if is_user else self.project_platform_dir)

    def destination_root(self, scope_root: Path, is_user: bool, root: str) -> Path:
        if root == "platform":
            return self.platform_root(scope_root, is_user)
        if root == "skills":
            return scope_root / (self.user_skills_dir if is_user else self.project_skills_dir)
        if root == "hooks":
            return self.platform_root(scope_root, is_user) / "hooks"
        raise ValueError(f"unknown destination root '{root}'")

    def config_path(self, scope_root: Path, is_user: bool, local: bool) -> Path:
        if local and not self.supports_local_config:
            raise ValueError(f"--local is not supported for the {self.product_name} target")
        name = "settings.local.json" if local else self.config_name
        return self.platform_root(scope_root, is_user) / name

    def gitignore_pattern(self, entry: str, is_user: bool) -> str:
        if is_user:
            return entry
        return f"{self.project_platform_dir}/{entry}"

    def placeholders(self, scope_root: Path, is_user: bool) -> dict[str, str]:
        platform_root = self.platform_root(scope_root, is_user).as_posix()
        skills_root = self.destination_root(scope_root, is_user, "skills").as_posix()
        hooks_root = self.destination_root(scope_root, is_user, "hooks").as_posix()
        return {
            "${PLATFORM_DIR}": platform_root,
            "${SKILLS_DIR}": skills_root,
            "${HOOKS_DIR}": hooks_root,
        }

    def prepare_config(self, base: dict, fragment: dict) -> dict:
        return copy.deepcopy(base)

    def merge_config(self, base: dict, fragment: dict) -> dict:
        return settings_merge.merge(base, fragment)

    def unmerge_config(self, base: dict, fragment: dict) -> dict:
        return settings_merge.unmerge(base, fragment)


class ClaudeAdapter(PlatformAdapter):
    def placeholders(self, scope_root: Path, is_user: bool) -> dict[str, str]:
        values = super().placeholders(scope_root, is_user)
        claude_dir = (
            self.platform_root(scope_root, is_user).as_posix()
            if is_user
            else "${CLAUDE_PROJECT_DIR}/.claude"
        )
        values["${CLAUDE_DIR}"] = claude_dir
        # Generic placeholders should retain Claude's relocatable project form.
        if not is_user:
            values["${PLATFORM_DIR}"] = claude_dir
            values["${SKILLS_DIR}"] = f"{claude_dir}/skills"
            values["${HOOKS_DIR}"] = f"{claude_dir}/hooks"
        return values

    def prepare_config(self, base: dict, fragment: dict) -> dict:
        healed = copy.deepcopy(base)
        restore_proxied_hooks(healed)
        rehome_moved_hooks(healed, fragment)
        return healed


class ChatGPTAdapter(PlatformAdapter):
    """Native ChatGPT layout.

    Project hook commands use the repo-relative ``.codex/hooks`` path.  Apart
    from avoiding platform-specific quoting in ChatGPT's single-string command
    field, this keeps a checkout relocatable.  User installs remain absolute:
    their hooks live outside the current project.
    """

    def placeholders(self, scope_root: Path, is_user: bool) -> dict[str, str]:
        values = super().placeholders(scope_root, is_user)
        if not is_user:
            values["${HOOKS_DIR}"] = f"{self.project_platform_dir}/hooks"
        values["${CHATGPT_CONFIG_DIR}"] = values["${PLATFORM_DIR}"]
        return values


ADAPTERS: dict[Platform, PlatformAdapter] = {
    Platform.CLAUDE: ClaudeAdapter(
        platform=Platform.CLAUDE,
        product_name="Claude Code",
        project_platform_dir=".claude",
        user_platform_dir=".claude",
        project_skills_dir=".claude/skills",
        user_skills_dir=".claude/skills",
        config_name="settings.json",
        supports_local_config=True,
        restart_guidance="Restart Claude Code (or run /doctor) to pick up the changes.",
        legacy_artifacts=(".harness.lock.json", "settings.json.bak", "settings.local.json.bak"),
    ),
    Platform.CHATGPT: ChatGPTAdapter(
        platform=Platform.CHATGPT,
        product_name="ChatGPT",
        project_platform_dir=".codex",
        user_platform_dir=".codex",
        project_skills_dir=".agents/skills",
        user_skills_dir=".agents/skills",
        config_name="hooks.json",
        supports_local_config=False,
        restart_guidance="Restart ChatGPT to pick up the changes and review any new hook definitions.",
    ),
}


def get_adapter(platform: Platform | str = Platform.CLAUDE) -> PlatformAdapter:
    return ADAPTERS[Platform.parse(platform)]


def restore_proxied_hooks(settings: dict) -> None:
    """Undo the retired Claude Code `stopHook` proxy convention, in place."""
    hooks = settings.get("hooks")
    if not isinstance(hooks, dict):
        return
    for groups in hooks.values():
        if not isinstance(groups, list):
            continue
        for group in groups:
            if not isinstance(group, dict) or not isinstance(group.get("hooks"), list):
                continue
            restored = []
            for entry in group["hooks"]:
                if isinstance(entry, dict) and isinstance(entry.get("_proxied"), list):
                    original = entry.pop("_proxied")
                    entry = {k: v for k, v in entry.items() if k not in ("command", "args")}
                    if original:
                        entry["command"], entry["args"] = original[0], original[1:]
                restored.append(entry)
            group["hooks"] = restored


def rehome_moved_hooks(settings: dict, fragment: dict) -> None:
    """Drop a Claude fragment's hooks from matcher groups it no longer claims."""
    hooks = settings.get("hooks")
    fragment_hooks = fragment.get("hooks")
    if not isinstance(hooks, dict) or not isinstance(fragment_hooks, dict):
        return
    for event, fragment_groups in fragment_hooks.items():
        groups = hooks.get(event)
        if not isinstance(groups, list) or not isinstance(fragment_groups, list):
            continue
        wanted: dict[tuple, set] = {}
        for group in fragment_groups:
            if not isinstance(group, dict):
                continue
            scope = settings_merge.normalize_scope(group)
            for entry in group.get("hooks", []):
                wanted.setdefault(settings_merge.identity(entry), set()).add(scope)
        if not wanted:
            continue
        kept = []
        for group in groups:
            if not isinstance(group, dict) or not isinstance(group.get("hooks"), list):
                kept.append(group)
                continue
            scope = settings_merge.normalize_scope(group)
            remaining = [
                entry
                for entry in group["hooks"]
                if scope in wanted.get(settings_merge.identity(entry), {scope})
            ]
            if remaining == group["hooks"]:
                kept.append(group)
            elif remaining:
                kept.append({**group, "hooks": remaining})
        if kept:
            hooks[event] = kept
        else:
            del hooks[event]
    if not hooks:
        del settings["hooks"]
