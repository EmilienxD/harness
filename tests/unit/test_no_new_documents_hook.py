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
    payload: dict,
    cwd: Path,
    hook_path: Path = HOOK,
    env: dict[str, str] | None = None,
    provider: str = "claude",
) -> tuple[int, dict | None, str]:
    result = subprocess.run(
        [sys.executable, str(hook_path), f"--{provider}"],
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


def pre_tool(tool: str, tool_input: dict, cwd: Path) -> dict:
    return {"hook_event_name": "PreToolUse", "tool_name": tool, "cwd": str(cwd), "tool_input": tool_input}


def prompt(text: str, cwd: Path, session: str = "session-1") -> dict:
    return {"hook_event_name": "UserPromptSubmit", "session_id": session, "cwd": str(cwd), "prompt": text}


def isolated_env(tmp_path: Path) -> dict[str, str]:
    env = dict(os.environ, HARNESS_STATE_DIR=str(tmp_path / "state"))
    env.pop("CLAUDE_PROJECT_DIR", None)
    return env


def write_draft(root: Path, target: str, content: str = "# Draft\n") -> Path:
    draft = root / ".harness" / "doc-drafts" / target
    draft.parent.mkdir(parents=True, exist_ok=True)
    draft.write_text(content, encoding="utf-8")
    return draft


@pytest.mark.parametrize("tool,tool_input", [
    ("Write", {"file_path": "docs/new.md", "content": "x"}),
    ("apply_patch", {"command": "*** Add File: docs/new.md\n+x"}),
    ("Bash", {"command": "printf x > docs/new.md"}),
    ("PowerShell", {"command": "Set-Content -Path docs/new.md -Value x"}),
    ("Bash", {"command": "cp source.md docs/"}),
])
@pytest.mark.parametrize("explicit_workdir", [False, True])
def test_codex_child_tool_keeps_session_policy_and_drafts(tmp_path, tool, tool_input, explicit_workdir):
    hook = staged_hook(tmp_path, 'version=1\nprotected=["child/docs/**"]\n')
    child = tmp_path / "child"
    (child / "docs").mkdir(parents=True)
    env = isolated_env(tmp_path)
    env["CLAUDE_PROJECT_DIR"] = str(child)
    payload = pre_tool(tool, dict(tool_input), tmp_path if explicit_workdir else child)
    if explicit_workdir:
        payload["tool_input"]["workdir"] = "child"

    code, output, stderr = run_hook(payload, tmp_path, hook, env, "chatgpt")

    assert (code, stderr) == (0, "")
    assert output["hookSpecificOutput"]["permissionDecision"] == "deny"
    target_name = "source.md" if tool_input.get("command") == "cp source.md docs/" else "new.md"
    draft_path = tmp_path / ".harness/doc-drafts/child/docs" / target_name
    assert draft_path.as_posix() in output["hookSpecificOutput"]["permissionDecisionReason"]
    assert (tmp_path / ".harness/doc-drafts/.gitignore").is_file()
    assert not (child / ".harness/doc-drafts").exists()
    assert not (child / "docs/new.md").exists()


def test_codex_draft_approval_uses_session_directory(tmp_path):
    child = tmp_path / "child"
    child.mkdir()
    draft = write_draft(tmp_path, "docs/new.md", "approved bytes\n")

    code, output, stderr = run_hook(
        prompt("$approve-doc-draft docs/new.md", child), tmp_path,
        env=isolated_env(tmp_path), provider="chatgpt",
    )

    assert (code, stderr) == (0, "")
    assert output["decision"] == "block"
    assert (tmp_path / "docs/new.md").read_text() == "approved bytes\n"
    assert not draft.exists()
    assert not (child / "docs/new.md").exists()


def test_codex_does_not_load_policy_from_above_session_directory(tmp_path):
    hook = staged_hook(tmp_path, 'version=1\nprotected=["*.private"]\n')
    child = tmp_path / "child"
    child.mkdir()
    assert run_hook(
        pre_tool("Write", {"file_path": "new.private", "content": "x"}, child),
        child, hook, isolated_env(tmp_path), "chatgpt",
    ) == (0, None, "")


def test_write_cannot_create_a_document_in_a_nested_docs_directory(tmp_path):
    staged_hook(tmp_path, 'version=1\nprotected=["**/docs/**"]\n')
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
    assert ".harness/doc-drafts/packages/api/docs/design.md" in decision["permissionDecisionReason"]
    assert not intended.exists()


def test_denied_creation_prepares_a_git_ignored_drafts_directory(tmp_path):
    run_hook(pre_tool("Write", {"file_path": "docs/new.md", "content": "x"}, tmp_path), tmp_path)

    ignore = tmp_path / ".harness" / "doc-drafts" / ".gitignore"
    assert ignore.read_text(encoding="utf-8").strip() == "*"


def test_drafts_can_be_written_although_they_mirror_a_protected_path(tmp_path):
    for tool, tool_input in [
        ("Write", {"file_path": ".harness/doc-drafts/docs/new.md", "content": "x"}),
        ("apply_patch", {"command": "*** Add File: .harness/doc-drafts/docs/new.md\n+x"}),
        ("Bash", {"command": "printf x > .harness/doc-drafts/docs/new.md"}),
    ]:
        code, output, stderr = run_hook(pre_tool(tool, tool_input, tmp_path), tmp_path)
        assert (code, output, stderr) == (0, None, ""), tool


def test_apply_patch_cannot_add_a_file_beneath_docs(tmp_path):
    staged_hook(tmp_path, 'version=1\nprotected=["**/docs/**"]\n')
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
    staged_hook(tmp_path, 'version=1\nprotected=["**/docs/**"]\n')
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
    staged_hook(tmp_path, 'version=1\nprotected=["**/docs/**"]\n')
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


@pytest.mark.parametrize(
    ("tool", "command"),
    [
        ("Bash", "mv .harness/doc-drafts/docs/plan.md docs/plan.md"),
        ("Bash", "cp -f '.harness/doc-drafts/docs/plan.md' docs/"),
        ("PowerShell", "Move-Item -Path .harness/doc-drafts/docs/plan.md -Destination docs/plan.md"),
        ("PowerShell", "Copy-Item .harness/doc-drafts/docs/plan.md docs"),
    ],
)
def test_moving_or_copying_a_draft_into_place_is_denied(tmp_path, tool, command):
    (tmp_path / "docs").mkdir()
    write_draft(tmp_path, "docs/plan.md")

    code, output, stderr = run_hook(pre_tool(tool, {"command": command}, tmp_path), tmp_path)

    assert (code, stderr) == (0, "")
    assert output is not None
    assert output["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert "docs/plan.md" in output["hookSpecificOutput"]["permissionDecisionReason"]
    assert not (tmp_path / "docs" / "plan.md").exists()


def test_moving_a_file_over_an_existing_document_is_allowed(tmp_path):
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "plan.md").write_text("old", encoding="utf-8")

    code, output, stderr = run_hook(
        pre_tool("Bash", {"command": "mv plan.md docs/plan.md"}, tmp_path), tmp_path
    )

    assert (code, output, stderr) == (0, None, "")


def blocked_message(provider: str, code: int, output: dict | None, stderr: str) -> str:
    """The text a blocked prompt shows the user; fails if the prompt went through."""
    if provider == "claude":
        assert (code, output) == (2, None)
        return stderr
    assert code == 0
    assert output is not None and output["decision"] == "block"
    return output["reason"]


@pytest.mark.parametrize(("provider", "sigil"), [("claude", "/"), ("chatgpt", "$")])
def test_approving_a_draft_moves_it_into_place_without_a_model_turn(tmp_path, provider, sigil):
    write_draft(tmp_path, "docs/arch/plan.md", "# Plan\n")

    code, output, stderr = run_hook(
        prompt(f"{sigil}approve-doc-draft docs/arch/plan.md", tmp_path),
        tmp_path,
        env=isolated_env(tmp_path),
        provider=provider,
    )

    message = blocked_message(provider, code, output, stderr)
    assert "docs/arch/plan.md" in message
    assert (tmp_path / "docs" / "arch" / "plan.md").read_text(encoding="utf-8") == "# Plan\n"
    assert not (tmp_path / ".harness" / "doc-drafts" / "docs").exists()


def test_approval_never_overwrites_a_document_that_appeared_meanwhile(tmp_path):
    draft = write_draft(tmp_path, "docs/plan.md", "draft")
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "plan.md").write_text("theirs", encoding="utf-8")

    code, output, stderr = run_hook(
        prompt("/approve-doc-draft docs/plan.md", tmp_path), tmp_path, env=isolated_env(tmp_path)
    )

    assert "docs/plan.md" in blocked_message("claude", code, output, stderr)
    assert (tmp_path / "docs" / "plan.md").read_text(encoding="utf-8") == "theirs"
    assert draft.read_text(encoding="utf-8") == "draft"


def test_rejecting_a_draft_directory_discards_every_draft_in_it(tmp_path):
    write_draft(tmp_path, "docs/guide/index.md")
    write_draft(tmp_path, "docs/guide/diagram.svg")
    kept = write_draft(tmp_path, "notes/docs/other.md")

    code, output, stderr = run_hook(
        prompt("/reject-doc-draft docs/guide", tmp_path), tmp_path, env=isolated_env(tmp_path)
    )

    message = blocked_message("claude", code, output, stderr)
    assert "docs/guide/index.md" in message and "docs/guide/diagram.svg" in message
    assert not (tmp_path / ".harness" / "doc-drafts" / "docs").exists()
    assert not (tmp_path / "docs").exists()
    assert kept.is_file()


def test_a_path_without_a_draft_is_reported_and_changes_nothing(tmp_path):
    kept = write_draft(tmp_path, "docs/plan.md")

    code, output, stderr = run_hook(
        prompt("/approve-doc-draft docs/typo.md", tmp_path), tmp_path, env=isolated_env(tmp_path)
    )

    assert "docs/typo.md" in blocked_message("claude", code, output, stderr)
    assert kept.is_file()
    assert not (tmp_path / "docs").exists()


@pytest.mark.parametrize("command", ["/approve-doc-draft", "/reject-doc-draft"])
def test_a_command_without_a_path_lists_pending_drafts_and_changes_nothing(tmp_path, command):
    drafts = [write_draft(tmp_path, "docs/a.md"), write_draft(tmp_path, "api/docs/b.md")]

    code, output, stderr = run_hook(prompt(command, tmp_path), tmp_path, env=isolated_env(tmp_path))

    message = blocked_message("claude", code, output, stderr)
    assert "docs/a.md" in message and "api/docs/b.md" in message
    assert all(draft.is_file() for draft in drafts)
    assert not (tmp_path / "docs").exists()


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_the_agent_sees_drafts_still_waiting_for_a_decision(tmp_path, provider):
    write_draft(tmp_path, "docs/plan.md")
    env = isolated_env(tmp_path)

    for message in ("Please revise the plan", "Anything else?"):
        code, output, stderr = run_hook(prompt(message, tmp_path), tmp_path, env=env, provider=provider)

        assert (code, stderr) == (0, "")
        assert output is not None
        context = output["hookSpecificOutput"]["additionalContext"]
        assert isinstance(context, str) and context


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_the_agent_learns_the_outcome_on_its_next_prompt_exactly_once(tmp_path, provider):
    env = isolated_env(tmp_path)
    write_draft(tmp_path, "docs/kept.md")
    write_draft(tmp_path, "docs/dropped.md")
    run_hook(prompt("/approve-doc-draft docs/kept.md", tmp_path), tmp_path, env=env, provider=provider)
    run_hook(prompt("/reject-doc-draft docs/dropped.md", tmp_path), tmp_path, env=env, provider=provider)

    other = run_hook(prompt("hello", tmp_path, session="session-2"), tmp_path, env=env, provider=provider)
    code, output, stderr = run_hook(prompt("continue", tmp_path), tmp_path, env=env, provider=provider)
    again = run_hook(prompt("continue", tmp_path), tmp_path, env=env, provider=provider)

    assert other == (0, None, "")
    assert (code, stderr) == (0, "")
    assert output is not None
    context = output["hookSpecificOutput"]["additionalContext"]
    assert "docs/kept.md" in context and "docs/dropped.md" in context
    assert again == (0, None, "")


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


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
@pytest.mark.parametrize("policy", [
    'version=1\nprotected=["**/docs/**", "../bad", 42]\nunprotected=["website/src/lib/docs/**", "/bad", false]\n',
    'version=1\nprotected=[]\n',
    'broken [ TOML\n',
    'version=99\nprotected=["**/docs/**"]\n',
    'version=1\nprotected="invalid"\n',
])
def test_invalid_policy_and_exclusions_do_not_block_source(tmp_path, provider, policy):
    hook = staged_hook(tmp_path, policy)
    assert run_hook(pre_tool("Write", {"file_path": "website/src/lib/docs/catalog.test.ts"}, tmp_path), tmp_path, hook, provider=provider) == (0, None, "")


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_project_exclusions_override_installed_policy_without_losing_valid_protection(tmp_path, provider):
    hook = staged_hook(tmp_path, 'version=1\nunprotected=["website/src/lib/docs/**", "../bad", 42]\n')
    hook.with_name("no-new-documents.toml").write_text(
        'version=1\nprotected=["**/docs/**", "../bad", false]\n', encoding="utf-8"
    )
    assert run_hook(pre_tool("Write", {"file_path": "website/src/lib/docs/catalog.test.ts"}, tmp_path), tmp_path, hook, provider=provider) == (0, None, "")
    code, output, stderr = run_hook(pre_tool("Write", {"file_path": "docs/new.md"}, tmp_path), tmp_path, hook, provider=provider)
    assert (code, stderr) == (0, "")
    assert output["hookSpecificOutput"]["permissionDecision"] == "deny"


def test_default_only_protects_root_docs(tmp_path):
    hook = staged_hook(tmp_path)
    for path in ("website/src/lib/docs/catalog.test.ts", "nested/docs/new.md"):
        assert run_hook(pre_tool("Write", {"file_path": path}, tmp_path), tmp_path, hook) == (0, None, "")
    assert run_hook(pre_tool("Write", {"file_path": "docs/new.md"}, tmp_path), tmp_path, hook)[1] is not None


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
    assert 'protected = ["docs/**"]' in config.read_text(encoding="utf-8")
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
    prompt_hook = json.dumps(settings["hooks"]["UserPromptSubmit"][0]["hooks"][0])
    assert "no_new_documents_hook.py" in prompt_hook
    assert f"--{platform}" in prompt_hook
    skills = tmp_path / (".claude" if platform == "claude" else ".agents") / "skills"
    for skill in ("approve-doc-draft", "reject-doc-draft"):
        assert (skills / skill / "SKILL.md").is_file()
        assert (skills / skill / "agents" / "openai.yaml").is_file() == (platform == "chatgpt")

    custom = 'version = 1\nprotected = ["docs/**", "notes/**"]\n'
    config.write_text(custom, encoding="utf-8")
    installer.reconcile({tool.name})
    assert config.read_text(encoding="utf-8") == custom
