"""Public-boundary tests for the cross-platform no-new-documents hook."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from harness_cli.installer import CatalogueInstaller, Target
from harness_cli.manifest import discover
from harness_cli.receipts import ReceiptStore


ROOT = Path(__file__).resolve().parents[2]
HOOK = (
    ROOT
    / "harness/guards/no-new-documents"
    / "no_new_documents_hook.py"
)


def run_hook(
    payload: dict, cwd: Path, hook_path: Path = HOOK, env: dict[str, str] | None = None
) -> tuple[int, dict | None, str]:
    result = subprocess.run(
        [sys.executable, str(hook_path)],
        cwd=cwd,
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        check=False,
        env=env,
    )
    stdout = result.stdout.strip()
    return result.returncode, json.loads(stdout) if stdout else None, result.stderr


def staged_hook(tmp_path: Path, config: str | None = None) -> Path:
    hook = tmp_path / "hooks" / HOOK.name
    hook.parent.mkdir()
    hook.write_bytes(HOOK.read_bytes())
    source_config = HOOK.parent / "no-new-documents.toml"
    shared_config = tmp_path / ".harness" / "guards" / source_config.name
    shared_config.parent.mkdir(parents=True)
    shared_config.write_text(
        config if config is not None else source_config.read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    return hook


def test_write_cannot_create_a_document_in_a_nested_docs_directory(tmp_path):
    intended = tmp_path / "packages" / "api" / "docs" / "design.md"

    code, output, stderr = run_hook(
        {
            "hook_event_name": "PreToolUse",
            "tool_name": "Write",
            "cwd": str(tmp_path),
            "tool_input": {"file_path": str(intended), "content": "# Design\n"},
        },
        tmp_path,
    )

    assert code == 0
    assert stderr == ""
    assert output is not None
    decision = output["hookSpecificOutput"]
    assert decision["permissionDecision"] == "deny"
    assert "packages/api/docs/design.md" in decision["permissionDecisionReason"]
    assert "final response" in decision["permissionDecisionReason"]
    assert "why" in decision["permissionDecisionReason"]


def test_apply_patch_cannot_add_a_file_beneath_docs(tmp_path):
    code, output, stderr = run_hook(
        {
            "hook_event_name": "PreToolUse",
            "tool_name": "apply_patch",
            "cwd": str(tmp_path),
            "tool_input": {
                "command": (
                    "*** Begin Patch\n"
                    "*** Add File: services/docs/runbook.md\n"
                    "+# Runbook\n"
                    "*** End Patch"
                )
            },
        },
        tmp_path,
    )

    assert code == 0
    assert stderr == ""
    assert output is not None
    assert output["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert "services/docs/runbook.md" in output["hookSpecificOutput"]["permissionDecisionReason"]


def test_existing_document_can_be_modified(tmp_path):
    existing = tmp_path / "docs" / "guide.md"
    existing.parent.mkdir()
    existing.write_text("old\n", encoding="utf-8")

    code, output, stderr = run_hook(
        {
            "hook_event_name": "PreToolUse",
            "tool_name": "Write",
            "cwd": str(tmp_path),
            "tool_input": {"file_path": str(existing), "content": "new\n"},
        },
        tmp_path,
    )

    assert (code, output, stderr) == (0, None, "")


def test_claude_project_root_wins_over_a_nested_working_directory(tmp_path):
    nested_cwd = tmp_path / "packages" / "api"
    nested_cwd.mkdir(parents=True)
    intended = tmp_path / "docs" / "proposal.md"
    env = dict(os.environ, CLAUDE_PROJECT_DIR=str(tmp_path))

    code, output, stderr = run_hook(
        {
            "hook_event_name": "PreToolUse",
            "tool_name": "Write",
            "cwd": str(nested_cwd),
            "tool_input": {"file_path": str(intended), "content": "proposal"},
        },
        nested_cwd,
        env=env,
    )

    assert code == 0
    assert stderr == ""
    assert output is not None
    assert "docs/proposal.md" in output["hookSpecificOutput"]["permissionDecisionReason"]


def test_shell_redirection_to_a_new_document_is_denied(tmp_path):
    code, output, stderr = run_hook(
        {
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "cwd": str(tmp_path),
            "tool_input": {"command": "printf '%s\\n' title > nested/docs/new.md"},
        },
        tmp_path,
    )

    assert code == 0
    assert stderr == ""
    assert output is not None
    assert output["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert "nested/docs/new.md" in output["hookSpecificOutput"]["permissionDecisionReason"]


def test_shell_commands_with_no_confident_creation_target_are_allowed(tmp_path):
    existing = tmp_path / "docs" / "existing.md"
    existing.parent.mkdir()
    existing.write_text("old\n", encoding="utf-8")
    for tool, command in [
        ("Bash", "grep docs README.md"),
        ("Bash", "printf '%s\\n' title > docs/existing.md"),
        ("PowerShell", "Get-Content docs\\existing.md"),
        ("PowerShell", "Set-Content docs\\existing.md -Value updated"),
    ]:
        code, output, stderr = run_hook(
            {
                "hook_event_name": "PreToolUse",
                "tool_name": tool,
                "cwd": str(tmp_path),
                "tool_input": {"command": command},
            },
            tmp_path,
        )
        assert (code, output, stderr) == (0, None, ""), (tool, command)


def test_powershell_explicit_new_file_creation_is_denied(tmp_path):
    code, output, stderr = run_hook(
        {
            "hook_event_name": "PreToolUse",
            "tool_name": "PowerShell",
            "cwd": str(tmp_path),
            "tool_input": {
                "command": "New-Item -ItemType File -Path 'packages/docs/notes.md'"
            },
        },
        tmp_path,
    )

    assert code == 0
    assert stderr == ""
    assert output is not None
    assert "packages/docs/notes.md" in output["hookSpecificOutput"]["permissionDecisionReason"]


@pytest.mark.parametrize(
    ("tool", "command", "path"),
    [
        ("Bash", "touch docs/todo.md", "docs/todo.md"),
        ("Bash", "Set-Content -LiteralPath docs/todo.md -Value todo", "docs/todo.md"),
        ("PowerShell", "Set-Content -LiteralPath docs/todo.md -Value todo", "docs/todo.md"),
        ("PowerShell", "'todo' | Out-File -FilePath docs/todo.md", "docs/todo.md"),
    ],
)
def test_other_explicit_shell_creation_forms_are_denied(tmp_path, tool, command, path):
    code, output, stderr = run_hook(
        {
            "hook_event_name": "PreToolUse",
            "tool_name": tool,
            "cwd": str(tmp_path),
            "tool_input": {"command": command},
        },
        tmp_path,
    )

    assert code == 0
    assert stderr == ""
    assert output is not None
    assert path in output["hookSpecificOutput"]["permissionDecisionReason"]


def test_root_anchored_pattern_can_limit_nested_docs_matching(tmp_path):
    hook = staged_hook(tmp_path, 'version = 1\nprotected = ["docs/**"]\n')
    code, output, stderr = run_hook(
        {
            "hook_event_name": "PreToolUse",
            "tool_name": "Write",
            "cwd": str(tmp_path),
            "tool_input": {"file_path": str(tmp_path / "nested" / "docs" / "new.md")},
        },
        tmp_path,
        hook,
    )
    assert (code, output, stderr) == (0, None, "")

    code, output, stderr = run_hook(
        {
            "hook_event_name": "PreToolUse",
            "tool_name": "Write",
            "cwd": str(tmp_path),
            "tool_input": {"file_path": str(tmp_path / "docs" / "new.md")},
        },
        tmp_path,
        hook,
    )
    assert code == 0
    assert stderr == ""
    assert output is not None
    assert output["hookSpecificOutput"]["permissionDecision"] == "deny"


def test_configuration_accepts_multiple_protected_paths(tmp_path):
    hook = staged_hook(tmp_path, 'version = 1\nprotected = ["**/docs/**", "**/project-notes/**"]\n')
    code, output, stderr = run_hook(
        {
            "hook_event_name": "PreToolUse",
            "tool_name": "Write",
            "cwd": str(tmp_path),
            "tool_input": {"file_path": "team/project-notes/decision.md"},
        },
        tmp_path,
        hook,
    )
    assert code == 0
    assert stderr == ""
    assert output is not None
    assert output["hookSpecificOutput"]["permissionDecision"] == "deny"


def test_project_toml_adds_protected_patterns_after_installed_config(tmp_path):
    config = tmp_path / ".harness/guards/no-new-documents.toml"
    config.parent.mkdir(parents=True)
    config.write_text('version=1\nprotected=["notes/**"]\n', encoding="utf-8")

    code, output, stderr = run_hook(
        {
            "hook_event_name": "PreToolUse",
            "tool_name": "apply_patch",
            "cwd": str(tmp_path),
            "tool_input": {"command": "*** Add File: notes/new.md\n+new"},
        },
        tmp_path,
    )

    assert (code, stderr) == (0, "")
    assert output["hookSpecificOutput"]["permissionDecision"] == "deny"


@pytest.mark.parametrize(
    ("platform", "settings_path", "matcher"),
    [
        ("claude", ".claude/settings.json", "Write|Bash|PowerShell"),
        ("chatgpt", ".codex/hooks.json", "Bash|apply_patch"),
    ],
)
def test_install_registers_both_platforms_and_preserves_editable_configuration(
    tmp_path, platform, settings_path, matcher
):
    tool = discover()["no-new-documents"]
    target = Target.for_project(tmp_path, platform=platform)
    installer = CatalogueInstaller(
        {tool.name: tool}, target, ReceiptStore.load(tmp_path / f"{platform}-receipts.json")
    )

    installer.reconcile({tool.name})

    product = ".claude" if platform == "claude" else ".codex"
    hook_dir = tmp_path / product / "hooks"
    hook = hook_dir / "no_new_documents_hook.py"
    config = tmp_path / ".harness/guards/no-new-documents.toml"
    assert hook.is_file()
    assert not (hook_dir / "no-new-documents.toml").exists()
    assert 'protected = ["**/docs/**"]' in config.read_text(encoding="utf-8")
    settings = json.loads((tmp_path / settings_path).read_text(encoding="utf-8"))
    group = settings["hooks"]["PreToolUse"][0]
    assert group["matcher"] == matcher
    rendered = json.dumps(group["hooks"][0])
    assert "no_new_documents_hook.py" in rendered
    if platform == "claude":
        assert "${CLAUDE_PROJECT_DIR}" in rendered
        assert "${CLAUDE_DIR}" not in rendered
    else:
        assert "${" not in rendered

    custom = 'version = 1\nprotected = ["docs/**", "notes/**"]\n'
    config.write_text(custom, encoding="utf-8")
    installer.reconcile({tool.name})
    assert config.read_text(encoding="utf-8") == custom
