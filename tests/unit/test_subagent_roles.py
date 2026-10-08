from __future__ import annotations

from pathlib import Path
import re

import pytest
import yaml

from subagents_runtime import roles, sessions, processes
from subagents_runtime.delegation import (
    RequestFileError, claim_instructions, enable_delegation, parse_request_file, process_inbox,
)
from subagents_runtime.hooks import handle


SECURITY = {
    "launcher": "security-with-agent",
    "skill": "security-audit",
    "modes": ["auto", "interactive"],
    "default-mode": "auto",
}


def install_registry(project, provider, tasks=None):
    path = project / ".harness" / "subagent-tasks.yaml"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(tasks if tasks is not None else {"security": SECURITY}), encoding="utf-8")
    return path


def install_personal_registry(tasks):
    path = roles.state_dir() / "subagent-tasks.yaml"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(tasks), encoding="utf-8")
    return path


def install_toolkit_registry(project, provider, tasks=None):
    root = project / (".claude" if provider == "claude" else ".agents") / "skills"
    path = root / "subagents-toolkit" / "SKILL.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "---\nname: subagents-toolkit\n---\n\n```yaml subagent-tasks\n"
        + yaml.safe_dump(tasks or {"security": SECURITY}) + "```\n",
        encoding="utf-8",
    )
    return path


def install_child(project, provider):
    root = project / (".claude" if provider == "claude" else ".agents") / "skills"
    path = root / "security-audit" / "SKILL.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("---\nname: security-audit\n---\nAudit the requested scope.\n", encoding="utf-8")
    return path


@pytest.fixture
def project(tmp_path, monkeypatch):
    project = tmp_path / "project"
    project.mkdir()
    (project / ".git").mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path / "home"))
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    monkeypatch.delenv("HARNESS_SESSION_ID", raising=False)
    monkeypatch.delenv("HARNESS_EXECUTION_ID", raising=False)
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    return project


@pytest.mark.parametrize(("provider", "invocation"), [
    ("claude", "plain"), ("claude", "tool"),
    ("chatgpt", "plain"), ("chatgpt", "tool"), ("chatgpt", "linked"),
])
def test_registered_launcher_enables_inbox_in_a_fresh_conversation(project, provider, invocation):
    install_registry(project, provider)
    payload = {"session_id": "parent", "cwd": str(project)}
    if invocation == "tool":
        payload.update(hook_event_name="PostToolUse", tool_name="Skill",
                       tool_input={"skill": "security-with-agent"}, tool_response={"success": True})
    else:
        token = "/security-with-agent" if provider == "claude" else "$security-with-agent"
        if invocation == "linked":
            token = f"[{token}]({project}/.agents/skills/security-with-agent/SKILL.md)"
        payload.update(hook_event_name="UserPromptSubmit", prompt=f"{token} inspect the API")
    assert handle(payload, provider) is not None
    with sessions._connect() as connection:
        assert connection.execute("SELECT count(*) FROM session_delegation WHERE parent_session_id='parent'").fetchone()[0] == 1
        assert connection.execute("SELECT count(*) FROM requests").fetchone()[0] == 0


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_unregistered_launcher_does_not_enable_inbox(project, provider):
    install_registry(project, provider)
    token = "/unknown-with-agent" if provider == "claude" else "$unknown-with-agent"
    assert handle({"session_id": "parent", "cwd": str(project),
                   "hook_event_name": "UserPromptSubmit", "prompt": token}, provider) is None
    with sessions._connect() as connection:
        assert connection.execute("SELECT count(*) FROM session_delegation").fetchone()[0] == 0
    with pytest.raises(sessions.SessionError, match="unknown delegation skill"):
        enable_delegation("parent", "unknown-with-agent")


@pytest.mark.parametrize("parent_provider", ["claude", "chatgpt"])
@pytest.mark.parametrize("child_provider", ["claude", "chatgpt"])
@pytest.mark.parametrize("mode", ["auto", "interactive"])
def test_custom_task_uses_parent_registry_and_native_child_profile(
    project, monkeypatch, parent_provider, child_provider, mode,
):
    install_registry(project, parent_provider)
    child_skill = install_child(project, child_provider)
    # The target provider's toolkit must not replace the parent's role definition.
    if parent_provider != child_provider:
        install_toolkit_registry(project, child_provider, {"different": {**SECURITY, "launcher": "different-with-agent"}})
    sessions.register_observed("parent", project, parent_provider)
    inbox = enable_delegation("parent", "security-with-agent").inbox
    request = inbox / "audit.md"
    request.write_text(f"---\ntask: security\nprovider: {child_provider}\nmode: {mode}\n---\nInspect the API.\n", encoding="utf-8")
    parsed = parse_request_file(request, inbox, parent_provider=parent_provider, cwd=project)
    assert parsed.task == "security"
    assert parsed.child_skill == "security-audit"
    assert parsed.provider == child_provider
    monkeypatch.setattr(sessions, "_discover_delegation_endpoint", lambda *_: pytest.fail("Custom task sent to Aboard"))
    monkeypatch.setattr(sessions, "_command_from_config", lambda *_: [child_provider])
    monkeypatch.setattr(sessions, "launch_configuration", lambda _: {
        "providers": {child_provider: {"delegations": {"security": {"effort": "high"}}}},
    })
    launches = []
    loaded_skills = []

    def start(execution, argv, environment, cwd, visible):
        launches.append((argv, environment, cwd, visible))
        # Emulate the provider resolving an explicit skill selector at startup.
        selector = argv[-1].splitlines()[0]
        prefix = "/" if child_provider == "claude" else "$"
        if selector.startswith(prefix):
            path = roles.find_skill(cwd, child_provider, selector[len(prefix):])
            if path:
                loaded_skills.append(path)
        processes.confirm_startup(execution)

    monkeypatch.setattr(processes, "start", start)
    [result] = process_inbox("parent", launch=sessions.launch_delegated)
    assert result.status == "launched"
    argv, environment, cwd, visible = launches[0]
    assert argv[0] == child_provider
    assert environment["HARNESS_PROVIDER"] == child_provider
    assert environment["HARNESS_EXECUTION_MODE"] == mode
    assert cwd == project.resolve()
    assert visible is (mode == "interactive")
    assert loaded_skills == [child_skill]
    assert ("--effort" in argv) if child_provider == "claude" else ("-c" in argv)
    with sessions._connect() as connection:
        assert connection.execute("SELECT task FROM requests").fetchone()[0] == "security"
        assert connection.execute("SELECT backend FROM executions").fetchone()[0] == "standalone"


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_missing_child_skill_fails_before_starting_any_process(project, monkeypatch, provider):
    install_registry(project, provider)
    sessions.register_observed("parent", project, provider)
    inbox = enable_delegation("parent", "security-with-agent").inbox
    (inbox / "audit.md").write_text("---\ntask: security\nmode: auto\n---\nInspect the API.\n", encoding="utf-8")
    monkeypatch.setattr(processes, "start", lambda *_args, **_kwargs: pytest.fail("Missing child launched"))
    monkeypatch.setattr(sessions, "_discover_delegation_endpoint", lambda *_: pytest.fail("Missing child sent to Aboard"))
    [result] = process_inbox("parent", launch=sessions.launch_delegated)
    assert result.status == "failed"
    assert "security-audit" in result.reason
    assert "unavailable" in result.reason


def test_custom_task_enforces_registered_modes_and_rejects_unknown_tasks(project):
    install_registry(project, "claude", {"security": {**SECURITY, "modes": ["interactive"], "default-mode": "interactive"}})
    inbox = project / "inbox"
    inbox.mkdir()
    request = inbox / "audit.md"
    for task, mode, reason in [("security", "auto", "unsupported mode"), ("unknown", "interactive", "unsupported task")]:
        request.write_text(f"---\ntask: {task}\nmode: {mode}\n---\nInspect the API.\n", encoding="utf-8")
        with pytest.raises(RequestFileError, match=reason):
            parse_request_file(request, inbox, parent_provider="claude", cwd=project)


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_resume_keeps_custom_identity_after_registry_is_removed(project, monkeypatch, provider):
    registry = install_registry(project, provider)
    sessions.register_observed("parent", project, provider)
    inbox = enable_delegation("parent", "security-with-agent").inbox
    (inbox / "audit.md").write_text("---\ntask: security\nmode: auto\n---\nInspect the API.\n", encoding="utf-8")
    [first] = process_inbox("parent", launch=lambda *_: "conversation")
    with sessions._connect() as connection:
        connection.execute("UPDATE requests SET state='succeeded' WHERE child_session_id=?", (first.child_session_id,))
        connection.execute("UPDATE executions SET state='exited' WHERE session_id=?", (first.child_session_id,))
    registry.unlink()
    (inbox / "continue.md").write_text("---\nresume: agent-1\n---\nInspect the next area.\n", encoding="utf-8")
    continued = []
    [result] = process_inbox("parent", launch=lambda request, *_: continued.append(request) or "conversation")
    assert result.status == "launched"
    assert result.child_session_id == first.child_session_id
    assert continued[0].task == "security"
    assert continued[0].mode == "auto"
    assert continued[0].provider == provider
    assert continued[0].resume == "agent-1"
    assert continued[0].child_skill is None


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_registry_resolution_prefers_nearest_project_then_personal(project, provider):
    personal = install_toolkit_registry(Path.home(), provider, {"personal": {**SECURITY, "launcher": "personal-with-agent"}})
    assert roles.find_skill(project, provider, "subagents-toolkit") == personal
    root = install_toolkit_registry(project, provider)
    nested = project / "module"
    nested.mkdir()
    assert roles.find_skill(nested, provider, "subagents-toolkit") == root
    nearest = install_toolkit_registry(nested, provider, {"nested": {**SECURITY, "launcher": "nested-with-agent"}})
    assert roles.find_skill(nested, provider, "subagents-toolkit") == nearest
    assert set(roles.load_task_policies(nested, provider)) == {"nested-with-agent", "ship"}


def test_registry_search_stops_at_repository_boundary(project):
    install_toolkit_registry(project.parent, "claude", {"outside": {**SECURITY, "launcher": "outside-with-agent"}})
    assert roles.find_skill(project, "claude", "subagents-toolkit") is None


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_hook_and_request_validation_use_the_saved_parent_directory(project, provider):
    install_registry(project, provider)
    nested = project / "module"
    nested.mkdir()
    install_registry(nested, provider, {"other": {**SECURITY, "launcher": "other-with-agent"}})
    sessions.register_observed("parent", project, provider)
    token = "/security-with-agent" if provider == "claude" else "$security-with-agent"
    assert handle({"session_id": "parent", "cwd": str(nested),
                   "hook_event_name": "UserPromptSubmit", "prompt": token}, provider) is not None
    inbox = enable_delegation("parent", "security-with-agent").inbox
    (inbox / "audit.md").write_text("---\ntask: security\nmode: auto\n---\nInspect the API.\n", encoding="utf-8")
    [result] = process_inbox("parent", launch=lambda *_: "conversation")
    assert result.status == "launched"


def test_claude_personal_toolkit_respects_config_directory(project, monkeypatch):
    registry = install_toolkit_registry(project.parent / "personal", "claude")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(registry.parents[2]))
    assert roles.find_skill(project, "claude", "subagents-toolkit") == registry


@pytest.mark.parametrize("changes", [
    {"launcher": "security"}, {"skill": None}, {"skill": "security-with-agent"},
    {"skill": "../escape"}, {"modes": ["loop"]}, {"default-mode": "loop"},
    {"unknown": True}, {"modes": []},
])
def test_malformed_registry_is_reported_instead_of_falling_back(project, changes):
    install_registry(project, "claude", {"security": {**SECURITY, **changes}})
    with pytest.raises(roles.RoleError):
        roles.load_task_policies(project, "claude")


def test_duplicate_launchers_and_task_names_are_rejected(project):
    path = install_registry(project, "claude", {"security": SECURITY, "other": SECURITY})
    with pytest.raises(roles.RoleError, match="duplicate launcher"):
        roles.load_task_policies(project, "claude")
    path.write_text("security: {}\nsecurity: {}\n", encoding="utf-8")
    with pytest.raises(roles.RoleError, match="duplicate registry key"):
        roles.load_task_policies(project, "claude")


def test_registry_reload_observes_new_entries_without_a_process_restart(project):
    install_registry(project, "claude")
    assert roles.task_policy("added", project, "claude") is None
    install_registry(project, "claude", {"security": SECURITY, "added": {**SECURITY, "launcher": "added-with-agent"}})
    assert roles.task_policy("added", project, "claude").skill == "security-audit"


def test_ship_and_resume_remain_available_when_the_role_registry_is_invalid(project):
    registry = install_registry(project, "claude")
    registry.write_text("Invalid registry", encoding="utf-8")
    sessions.register_observed("parent", project, "claude")
    inbox = enable_delegation("parent", "ship").inbox
    assert enable_delegation("parent", "resume-agent").inbox == inbox
    assert roles.task_policy("loop", project, "claude") == roles.LOOP_POLICY


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_custom_registry_preserves_all_builtin_tasks(project, provider):
    defaults = roles.read_task_policies(roles.builtin_toolkit())
    assert roles.load_task_policies(project, provider) == {**defaults, "ship": roles.LOOP_POLICY}
    install_registry(project, provider)
    assert roles.load_task_policies(project, provider) == {
        **defaults, "security-with-agent": roles.TaskPolicy(
            "security", frozenset({"auto", "interactive"}), "security-audit", "auto",
        ), "ship": roles.LOOP_POLICY,
    }


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_custom_registry_merges_personal_and_nearest_project_by_task(project, provider):
    install_personal_registry({
        "security": SECURITY,
        "personal": {**SECURITY, "launcher": "personal-with-agent"},
    })
    install_registry(project, provider, {"root": {**SECURITY, "launcher": "root-with-agent"}})
    nested = project / "module"
    nested.mkdir()
    install_registry(nested, provider, {
        "security": {**SECURITY, "launcher": "project-security-with-agent",
                     "modes": ["interactive"], "default-mode": "interactive"},
    })
    policies = roles.load_task_policies(nested, provider)
    assert policies["personal-with-agent"].task == "personal"
    assert policies["project-security-with-agent"].default_mode == "interactive"
    assert policies["project-security-with-agent"].modes == frozenset({"interactive"})
    assert "security-with-agent" not in policies
    assert "root-with-agent" not in policies
    assert "work-with-agent" in policies


def test_personal_custom_registry_defaults_to_home(project, monkeypatch):
    monkeypatch.delenv("HARNESS_STATE_DIR")
    install_registry(Path.home(), "claude")
    assert roles.task_policy("security", project, "claude").skill == "security-audit"
    assert roles.task_policy("security", project, "chatgpt").skill == "security-audit"


def test_custom_registry_search_stops_at_repository_boundary(project):
    install_registry(project.parent, "claude")
    assert roles.task_policy("security", project, "claude") is None


def test_empty_custom_registry_uses_defaults(project):
    install_registry(project, "claude", {})
    assert roles.load_task_policies(project, "claude") == {
        **roles.read_task_policies(roles.builtin_toolkit()), "ship": roles.LOOP_POLICY,
    }


@pytest.mark.parametrize("content", ["", "null", "[]", "security: [", "1: {}"])
def test_invalid_custom_yaml_reports_its_source(project, content):
    registry = install_registry(project, "claude")
    registry.write_text(content, encoding="utf-8")
    with pytest.raises(roles.RoleError) as error:
        roles.load_task_policies(project, "claude")
    assert str(registry) in str(error.value)


@pytest.mark.parametrize(("task", "launcher"), [
    ("general", "security-with-agent"), ("security", "work-with-agent"),
    ("ship", "security-with-agent"), ("loop", "security-with-agent"),
])
def test_custom_registry_cannot_replace_builtin_or_internal_roles(project, task, launcher):
    install_registry(project, "claude", {task: {**SECURITY, "launcher": launcher}})
    with pytest.raises(roles.RoleError):
        roles.load_task_policies(project, "claude")


def test_duplicate_launchers_across_personal_and_project_are_rejected(project):
    install_personal_registry({"personal": SECURITY})
    install_registry(project, "claude")
    with pytest.raises(roles.RoleError, match="duplicate launcher"):
        roles.load_task_policies(project, "claude")


def test_builtin_task_table_matches_runtime_definitions():
    toolkit = roles.builtin_toolkit()
    [block] = re.findall(r"^```yaml\r?\n(.*?)^```[ \t]*$", toolkit.read_text(encoding="utf-8"), re.MULTILINE | re.DOTALL)
    displayed = yaml.safe_load(block)
    runtime = roles.read_task_policies(toolkit)
    assert set(displayed) == {policy.task for policy in runtime.values()}
    for launcher, policy in runtime.items():
        assert displayed[policy.task]["launcher"] == launcher
        assert displayed[policy.task]["default-mode"] == policy.default_mode
        assert frozenset(displayed[policy.task]["modes"]) == policy.modes


def test_builtin_definitions_load_without_reading_skill_body(project, monkeypatch):
    toolkit = roles.builtin_toolkit()
    expected = roles.read_task_policies(toolkit)
    original_read = Path.read_text

    def read_data_only(path, *args, **kwargs):
        if path.suffix == ".md":
            pytest.fail("Task routing must not depend on the instruction body")
        return original_read(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", read_data_only)
    assert roles.load_task_policies(project, "claude") == {**expected, "ship": roles.LOOP_POLICY}


def test_invalid_companion_registry_is_reported_without_legacy_fallback(project):
    toolkit = install_toolkit_registry(project, "claude")
    companion = toolkit.with_name("builtin-tasks.yaml")
    companion.write_text("{}", encoding="utf-8")
    with pytest.raises(roles.RoleError) as error:
        roles.load_task_policies(project, "claude")
    assert str(companion) in str(error.value)


def test_runtime_context_resolves_custom_registry_paths_from_saved_directory(project, monkeypatch):
    registry = install_registry(project, "claude")
    nested = project / "module"
    nested.mkdir()
    sessions.register_observed("parent", nested, "claude")
    enable_delegation("parent", "work-with-agent")
    expected_paths = (roles.state_dir() / "subagent-tasks.yaml", registry)
    assert roles.custom_registry_paths(nested) == expected_paths
    calls = []

    def resolve(cwd):
        calls.append(cwd)
        return expected_paths

    monkeypatch.setattr(roles, "custom_registry_paths", resolve)
    assert claim_instructions("parent") is not None
    assert calls == [nested.resolve()]
