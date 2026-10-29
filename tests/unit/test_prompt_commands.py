from __future__ import annotations

import hashlib
import re
from difflib import SequenceMatcher

import pytest

from subagents_runtime import sessions
from subagents_runtime.delegation import enable_delegation, process_inbox
from subagents_runtime.prompt_commands import BUILTIN_COMMANDS, sanitize_prompt_commands


def assert_only_prefixes_deleted(before, after, count):
    edits = [opcode for opcode in SequenceMatcher(a=before, b=after).get_opcodes() if opcode[0] != "equal"]
    assert len(edits) == count
    for operation, start, end, _, _ in edits:
        assert operation == "delete"
        assert end - start == 1
        assert before[start] in "/$"


@pytest.mark.parametrize("provider", ["claude", "chatgpt", "pi"])
def test_every_builtin_command_loses_exactly_its_prefix(tmp_path, provider):
    # This is syntax normalization: assert removed prefix positions, never
    # wording in an agent's instructions.
    for name in BUILTIN_COMMANDS[provider]:
        token = "/" + name
        converted = sanitize_prompt_commands(token, provider)
        assert_only_prefixes_deleted(token, converted, 1)
        assert_only_prefixes_deleted(converted, sanitize_prompt_commands(converted, provider), 0)


@pytest.mark.parametrize("provider,prefix", [("claude", "/"), ("chatgpt", "$")])
def test_installed_skills_and_aliases_survive(tmp_path, provider, prefix):
    directory = ".claude" if provider == "claude" else ".agents"
    skill = tmp_path / directory / "skills" / "custom-audit" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("---\nname: custom-alias\n---\n", encoding="utf-8")
    for name in ("custom-audit", "custom-alias", "prototype", "plugin:custom-audit", "skill-creator", "clear"):
        for marker in ("/", "$"):
            token = marker + name
            converted = sanitize_prompt_commands(token, provider)
            assert_only_prefixes_deleted(token, converted, int(marker == "/" and name == "clear"))


@pytest.mark.parametrize("name", [
    "artifact-capabilities", "artifact-diagramming", "batch", "claude-api",
    "claude-in-chrome", "code-review", "review", "checkup", "dataviz", "debug",
    "design", "design-sync", "doctor", "fewer-permission-prompts", "loop",
    "proactive", "plugin-authoring", "run", "run-skill-generator", "simplify",
    "slides", "ultrareview", "update-config", "verify", "workflow-authoring",
    "deep-research",
])
def test_claude_bundled_skills_and_aliases_survive(name):
    token = "/" + name
    assert_only_prefixes_deleted(token, sanitize_prompt_commands(token, "claude"), 0)


@pytest.mark.parametrize("provider", ["claude", "chatgpt", "pi"])
@pytest.mark.parametrize("token", [
    "/taxonomy", "/taxonomy/catalog", "/tmp", "/usr", "/clear/file",
    r"/clear\file", "$HOME", "$unknown-skill", "/unknown-skill",
    "https://example.com/clear", "./clear", "../clear", "~/clear", "/clear.py",
    "é/resume", "Ⅻ/resume", "/skill:prototype", "/plugin:custom-audit",
])
def test_paths_unknown_names_and_variables_survive(tmp_path, provider, token):
    converted = sanitize_prompt_commands(token, provider)
    assert_only_prefixes_deleted(token, converted, 0)


def test_punctuation_repeated_mentions_and_legacy_claude_commands(tmp_path):
    command = tmp_path / ".claude" / "commands" / "frontend" / "audit.md"
    command.parent.mkdir(parents=True)
    command.touch()
    body = "(/clear), `/frontend:audit`\n/clear\n/clear-file /taxonomy/catalog"
    converted = sanitize_prompt_commands(body, "claude")
    assert_only_prefixes_deleted(body, converted, 2)
    assert re.findall(r"/[\w:-]+", converted) == ["/frontend:audit", "/clear-file", "/taxonomy", "/catalog"]


@pytest.mark.parametrize("provider,prefix", [("claude", "/"), ("chatgpt", "$")])
def test_explicit_skill_is_added_after_sanitization(tmp_path, monkeypatch, provider, prefix):
    from subagents_runtime import processes

    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(sessions, "launch_configuration", lambda _cwd: {})
    monkeypatch.setattr(sessions, "_provider_command", lambda _config, _provider: [_provider])
    from subagents_runtime import bridge_backend
    monkeypatch.setattr(bridge_backend, "discover", lambda *_args: None)
    directory = ".claude" if provider == "claude" else ".agents"
    skill = tmp_path / directory / "skills" / "prototype" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.touch()
    sessions.register_observed("parent", tmp_path, provider)
    inbox = enable_delegation("parent", "subagents-toolkit").inbox
    (inbox / "first.md").write_text(
        f"---\nskill: prototype\nmode: interactive\n---\n{prefix}prototype\n/clear",
        encoding="utf-8",
    )
    invocations = []

    def start(execution_id, argv, *_args, **_kwargs):
        invocations.extend(re.findall(r"([/$])([\w-]+)", argv[-1]))
        with sessions._connect() as connection:
            connection.execute("UPDATE executions SET state='exited' WHERE id=?", (execution_id,))

    monkeypatch.setattr(processes, "start", start)
    [result] = process_inbox("parent", launch=sessions.launch_delegated)

    assert result.status == "launched", result.reason
    assert invocations == [(prefix, "prototype")] * 2


@pytest.mark.parametrize("provider", ["claude", "chatgpt", "codex"])
@pytest.mark.parametrize("recover", [False, True])
def test_launch_recovery_and_resume_sanitize_using_child_directory_and_provider(
    tmp_path, monkeypatch, provider, recover
):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    parent_provider = "chatgpt" if provider == "claude" else "claude"
    sessions.register_observed("parent", tmp_path, parent_provider)
    inbox = enable_delegation("parent", "subagents-toolkit").inbox
    root = tmp_path / "child"
    directory = ".claude" if provider == "claude" else ".agents"
    skill = root / directory / "skills" / "custom-audit" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.touch()
    body = "/clear\n/custom-audit $custom-audit /taxonomy/catalog $HOME"
    (inbox / "first.md").write_text(
        f"---\nmode: auto\nprovider: {provider}\nroot: {root.as_posix()}\n---\n{body}",
        encoding="utf-8",
    )
    launches = []

    def adapter(request, *_args):
        launches.append((len(body) - len(request.prompt), re.findall(r"[/\$]custom-audit", request.prompt)))
        return "saved-conversation"

    if recover:
        def crash(*_args):
            raise KeyboardInterrupt()
        with pytest.raises(KeyboardInterrupt):
            process_inbox("parent", launch=crash)
        with sessions._connect() as connection:
            connection.execute("UPDATE executions SET reservation_pid=2147483647,reservation_birth='dead'")

    [first] = process_inbox("parent", launch=adapter)
    assert first.status == "launched"
    with sessions._connect() as connection:
        digest = connection.execute("SELECT prompt_hash FROM requests WHERE id=?", (first.request_id,)).fetchone()[0]
        connection.execute("UPDATE executions SET state='exited' WHERE request_id=?", (first.request_id,))
        connection.execute("UPDATE requests SET state='succeeded' WHERE id=?", (first.request_id,))
    assert digest == hashlib.sha256(body.encode()).hexdigest()
    (inbox / "next.md").write_text(f"---\nresume: agent-1\n---\n{body}", encoding="utf-8")
    [continued] = process_inbox("parent", launch=adapter)
    assert continued.status == "launched", continued.reason
    assert continued.child_session_id == first.child_session_id
    assert launches == [(1, ["/custom-audit", "$custom-audit"])] * 2
