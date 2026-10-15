from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from subagents_runtime.delegation import (
    PROVIDERS,
    PROVIDER_ALIASES,
    RequestFileError,
    enable_delegation,
    process_inbox,
    parse_request_file,
)
from subagents_runtime import sessions
from subagents_runtime.roles import TaskPolicy, load_task_policies


FIXTURES = Path(__file__).parent / "fixtures" / "delegation_requests"


def write_request(inbox: Path, name: str, contents: str) -> Path:
    inbox.mkdir(parents=True, exist_ok=True)
    path = inbox / name
    path.write_text(contents, encoding="utf-8")
    return path


def test_request_file_parses_the_public_frontmatter_contract() -> None:
    inbox = FIXTURES
    request = inbox / "prototype-interactive.md"

    parsed = parse_request_file(
        request,
        inbox,
        parent_provider="claude",
    )

    assert parsed.task == "prototype"
    assert parsed.provider == "chatgpt"
    assert parsed.mode == "interactive"
    assert parsed.prompt == "Build a disposable UI experiment from the supplied fresh context."
    assert parsed.path == request.resolve()


def test_published_schemas_describe_the_implemented_contracts() -> None:
    schemas = Path(sessions.__file__).parent / "schemas"
    request = json.loads((schemas / "delegation-request.schema.json").read_text(encoding="utf-8"))
    aboard = json.loads((schemas / "aboard-delegation.schema.json").read_text(encoding="utf-8"))
    policies = load_task_policies(Path.cwd(), "claude")
    tasks = {policy.task for policy in policies.values()}
    modes = {mode for policy in policies.values() for mode in policy.modes}

    # The prompt is the Markdown body, so it is never a frontmatter key.
    assert set(request["properties"]) == {"task", "provider", "mode", "model", "effort", "root", "resume", "cwd", "difficulty", "prompt-file"}
    assert request["oneOf"][0]["required"] == ["task", "mode"]
    assert request["properties"]["task"]["type"] == "string"
    assert set(request["properties"]["mode"]["enum"]) == modes
    # Frontmatter accepts provider aliases; the wire schema stays canonical.
    assert set(request["properties"]["provider"]["enum"]) == set(PROVIDERS) | set(PROVIDER_ALIASES)

    assert set(aboard["required"]) <= set(aboard["properties"])
    assert set(aboard["properties"]["task"]["enum"]) == tasks
    assert set(aboard["properties"]["mode"]["enum"]) == modes
    assert set(aboard["properties"]["provider"]["enum"]) == set(PROVIDERS)


def test_codex_is_an_alias_of_chatgpt(tmp_path: Path) -> None:
    inbox = tmp_path / "inbox"
    request = write_request(
        inbox,
        "research.md",
        "---\ntask: websearch\nprovider: codex\nmode: auto\n---\n\nFind primary sources.\n",
    )

    parsed = parse_request_file(
        request,
        inbox,
        parent_provider="claude",
    )

    assert parsed.provider == "chatgpt"
    assert parsed.model is None
    assert parsed.effort is None


@pytest.mark.parametrize("effort", ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
def test_request_accepts_effort_independently_of_model(tmp_path: Path, effort: str) -> None:
    inbox = tmp_path / "inbox"
    request = write_request(inbox, "work.md", f"---\ntask: general\nmode: auto\neffort: {effort}\n---\nWork.")

    parsed = parse_request_file(request, inbox, parent_provider="claude")

    assert parsed.effort == effort
    assert parsed.model is None


def test_provider_defaults_to_the_parent_provider(tmp_path: Path) -> None:
    inbox = tmp_path / "inbox"
    request = write_request(
        inbox,
        "research.md",
        "---\ntask: websearch\nmode: auto\n---\n\nFind primary sources.\n",
    )

    parsed = parse_request_file(
        request,
        inbox,
        parent_provider="chatgpt",
    )

    assert parsed.provider == "chatgpt"
    assert parsed.root is None


def test_root_resolves_from_parent_directory(tmp_path: Path) -> None:
    parent = tmp_path / "project"
    root = tmp_path / "worktree"
    parent.mkdir()
    root.mkdir()
    inbox = tmp_path / "inbox"
    request = write_request(inbox, "work.md", "---\ntask: general\nmode: auto\nroot: ../worktree\n---\nWork")

    parsed = parse_request_file(request, inbox, parent_provider="claude", cwd=parent)

    assert parsed.root == root.resolve()


@pytest.mark.parametrize(
    ("name", "contents", "message"),
    [
        ("request.txt", "---\ntask: general\nmode: auto\n---\nbody", "Markdown"),
        ("request.md", "---\ntask: general\nmode: auto\nextra: no\n---\nbody", "unsupported frontmatter"),
        ("request.md", "---\ntask: [general]\nmode: auto\n---\nbody", "scalar string"),
        ("request.md", "---\ntask: general\nmode: auto\nmodel: null\n---\nbody", "scalar string"),
        ("request.md", "---\ntask: general\nmode: auto\nmodel: 123\n---\nbody", "scalar string"),
        ("request.md", "---\ntask: general\nmode: auto\nmodel: [gpt-6.1-sol]\n---\nbody", "scalar string"),
        ("request.md", "---\ntask: general\nmode: auto\nmodel: ' '\n---\nbody", "scalar string"),
        ("request.md", "---\ntask: general\nmode: auto\neffort: null\n---\nbody", "scalar string"),
        ("request.md", "---\ntask: general\nmode: auto\neffort: 123\n---\nbody", "scalar string"),
        ("request.md", "---\ntask: general\nmode: auto\neffort: [high]\n---\nbody", "scalar string"),
        ("request.md", "---\ntask: general\nmode: auto\neffort: ' '\n---\nbody", "scalar string"),
        ("request.md", "---\ntask: general\nmode: auto\neffort: invalid\n---\nbody", "unsupported effort"),
        ("request.md", "---\nresume: agent-1\neffort: high\n---\nbody", "resume requires only"),
        ("request.md", "---\ntask: general\nmode: auto\nroot: missing\n---\nbody", "existing directory"),
        ("request.md", "---\ntask: general\nmode: auto\nroot: null\n---\nbody", "scalar string"),
        ("request.md", "---\ntask: general\nmode: auto\nroute: ../worktree\n---\nbody", "unsupported frontmatter"),
        ("request.md", "---\ntask: loop\nmode: loop\ncwd: /tmp\nprompt-file: /tmp/prompt\nroot: /tmp\n---\nbody", "instead of root"),
        ("request.md", "---\nresume: agent-1\nmodel: gpt-6.1-sol\n---\nbody", "resume requires only"),
        ("request.md", "---\nresume: agent-1\nroot: elsewhere\n---\nbody", "resume requires only"),
        ("request.md", "---\ntask: general\n---\nbody", "mode"),
        ("request.md", "---\ntask: general\nmode: auto\n---\n", "body"),

        ("request.md", "---\ntask: general\nmode: invalid\n---\nbody", "unsupported mode"),
        ("request.md", "---\ntask: prototype\nmode: auto\n---\nbody", "unsupported mode"),
        ("request.md", "---\ntask: general\nmode: auto\n---\n$prototype do something else", "plain prompt"),
        ("request.md", "---\ntask: general\nmode: auto\n---\nPlease use $prototype for this", "plain prompt"),
        ("request.md", "task: general\nmode: auto\nbody", "frontmatter"),
    ],
)
def test_request_file_rejects_invalid_or_unauthorized_input(
    tmp_path: Path, name: str, contents: str, message: str
) -> None:
    inbox = tmp_path / "inbox"
    request = write_request(inbox, name, contents)

    with pytest.raises(RequestFileError, match=message):
        parse_request_file(
            request,
            inbox,
            parent_provider="claude",
        )


def test_request_file_rejects_nested_and_outside_paths(tmp_path: Path) -> None:
    inbox = tmp_path / "inbox"
    nested = write_request(
        inbox / "nested", "request.md", "---\ntask: general\nmode: auto\n---\nbody"
    )
    outside = write_request(
        tmp_path / "outside", "request.md", "---\ntask: general\nmode: auto\n---\nbody"
    )
    policy = TaskPolicy("general", frozenset({"interactive", "auto"}))

    with pytest.raises(RequestFileError, match="direct child"):
        parse_request_file(nested, inbox, parent_provider="claude")
    with pytest.raises(RequestFileError, match="canonical inbox"):
        parse_request_file(outside, inbox, parent_provider="claude")


def test_request_file_rejects_a_symlink(tmp_path: Path) -> None:
    inbox = tmp_path / "inbox"
    target = write_request(
        tmp_path, "target.md", "---\ntask: general\nmode: auto\n---\nbody"
    )
    link = inbox / "request.md"
    inbox.mkdir()
    try:
        link.symlink_to(target)
    except OSError:
        pytest.skip("symlinks are unavailable for this user")

    with pytest.raises(RequestFileError, match="symlink"):
        parse_request_file(
            link,
            inbox,
            parent_provider="claude",
        )


def configured_parent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> str:
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(sessions, "_visible_terminal", lambda *_args: None)
    monkeypatch.setattr(sessions, "_command_from_config", lambda _config, _provider="claude": ["claude"])
    from subagents_runtime import processes
    monkeypatch.setattr(processes,"start",lambda execution_id,*args,**kwargs: processes.confirm_startup(execution_id))
    return sessions.launch(provider="claude", cwd=tmp_path / "project")


def test_live_grant_processes_three_siblings_independently(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    parent = configured_parent(tmp_path, monkeypatch)
    grant = enable_delegation(parent, "work-with-agent", original_cwd=tmp_path / "project")
    write_request(grant.inbox, "one.md", "---\ntask: general\nmode: auto\n---\n\nOne")
    write_request(grant.inbox, "bad.md", "---\ntask: invalid\nmode: auto\n---\n\nBad")
    write_request(grant.inbox, "two.md", "---\ntask: general\nmode: interactive\n---\n\nTwo")
    write_request(grant.inbox, "three.md", "---\ntask: general\nprovider: chatgpt\nmode: auto\n---\n\nThree")

    launched: list[tuple[str, str, str, Path]] = []
    results = process_inbox(
        grant.id,
        launch=lambda request, request_id, _agent_number, cwd: launched.append(
            (request.path.name, request.provider, request_id, cwd)
        ) or f"child-{request.path.stem}",
    )

    assert [result.status for result in results] == ["failed", "launched", "launched", "launched"]
    assert [name for name, _provider, _request_id, _cwd in launched] == ["one.md", "three.md", "two.md"]
    assert len({request_id for _name, _provider, request_id, _cwd in launched}) == 3
    assert {cwd for _name, _provider, _request_id, cwd in launched} == {grant.original_cwd}
    assert grant.inbox.exists()


def test_explicit_root_is_persisted_for_resume(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    parent = configured_parent(tmp_path, monkeypatch)
    grant = enable_delegation(parent, "work-with-agent", original_cwd=tmp_path / "project")
    root = tmp_path / "worktree"
    root.mkdir()
    write_request(grant.inbox, "one.md", "---\ntask: general\nmode: auto\nroot: ../worktree\n---\nWork")
    launched: list[Path] = []

    [first] = process_inbox(grant.id, launch=lambda _request, _id, _number, cwd: launched.append(cwd) or "child")

    assert first.status == "launched"
    assert launched == [root.resolve()]
    with sessions._connect() as connection:
        assert connection.execute("SELECT cwd FROM sessions WHERE id=?", (first.child_session_id,)).fetchone()[0] == str(root.resolve())


def test_ask_requires_a_live_grant(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    configured_parent(tmp_path, monkeypatch)

    with pytest.raises(sessions.SessionError, match="enabled session inbox"):
        process_inbox("not-a-grant", launch=lambda *_args: "never")


def test_grant_policy_is_the_exact_authorization_table() -> None:
    assert load_task_policies(Path.cwd(), "claude") == {
        "explore-with-agent": TaskPolicy("explore", frozenset({"auto"})),
        "prototype-with-agent": TaskPolicy("prototype", frozenset({"interactive"}), "prototype", "interactive"),
        "websearch-with-agent": TaskPolicy("websearch", frozenset({"interactive", "auto"}), "websearch"),
        "brainstorm-with-agent": TaskPolicy("brainstorm", frozenset({"interactive"}), "grill-me", "interactive"),
        "address-with-agent": TaskPolicy("address", frozenset({"interactive", "auto"}), "address-this"),
        "review-with-agent": TaskPolicy("review", frozenset({"interactive", "auto"}), "review-this"),
        "work-with-agent": TaskPolicy("general", frozenset({"interactive", "auto"}), default_mode="interactive"),
        "ship": TaskPolicy("loop", frozenset({"loop"}), default_mode="loop"),
    }


def test_uncertain_launch_is_reserved_before_the_external_call_and_never_retried(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    parent = configured_parent(tmp_path, monkeypatch)
    grant = enable_delegation(parent, "work-with-agent", original_cwd=tmp_path / "project")
    request = write_request(grant.inbox, "one.md", "---\ntask: general\nmode: auto\n---\n\nOne")

    class SimulatedProcessDeath(BaseException):
        pass

    with pytest.raises(SimulatedProcessDeath):
        process_inbox(grant.id, launch=lambda *_args: (_ for _ in ()).throw(SimulatedProcessDeath()))
    with sessions._connect() as connection:
        connection.execute("UPDATE executions SET state='starting' WHERE request_id IN (SELECT id FROM requests WHERE source_name='one.md')")
    from subagents_runtime import processes
    monkeypatch.setattr(processes,'birth_identity',lambda pid: 'reused-pid')
    assert process_inbox(grant.id, launch=lambda *_args: pytest.fail("uncertain launch duplicated"))[0].status == "uncertain"

    connection = sqlite3.connect(tmp_path / "state" / "sessions.sqlite3")
    try:
        assert connection.execute("SELECT state FROM requests WHERE source_name = ?", (request.name,)).fetchone()[0] == "uncertain"
    finally:
        connection.close()
