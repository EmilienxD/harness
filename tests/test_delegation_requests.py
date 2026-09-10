from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from harness_cli.delegation import (
    GRANT_POLICIES,
    PROVIDERS,
    GrantPolicy,
    RequestFileError,
    open_grant,
    process_grant,
    parse_request_file,
)
from harness_cli import sessions


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
        GrantPolicy("prototype", frozenset({"interactive", "auto"})),
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
    tasks = {policy.task for policy in GRANT_POLICIES.values()}
    modes = {mode for policy in GRANT_POLICIES.values() for mode in policy.modes}

    # The prompt is the Markdown body, so it is never a frontmatter key.
    assert set(request["properties"]) == {"task", "provider", "mode"}
    assert set(request["required"]) == {"task", "mode"}
    assert set(request["properties"]["task"]["enum"]) == tasks
    assert set(request["properties"]["mode"]["enum"]) == modes
    assert set(request["properties"]["provider"]["enum"]) == set(PROVIDERS)

    assert set(aboard["required"]) == set(aboard["properties"])
    assert set(aboard["properties"]["task"]["enum"]) == tasks
    assert set(aboard["properties"]["mode"]["enum"]) == modes
    assert set(aboard["properties"]["provider"]["enum"]) == set(PROVIDERS)


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
        GrantPolicy("websearch", frozenset({"interactive", "auto"})),
        parent_provider="chatgpt",
    )

    assert parsed.provider == "chatgpt"


@pytest.mark.parametrize(
    ("name", "contents", "message"),
    [
        ("request.txt", "---\ntask: general\nmode: auto\n---\nbody", "Markdown"),
        ("request.md", "---\ntask: general\nmode: auto\nextra: no\n---\nbody", "unsupported frontmatter"),
        ("request.md", "---\ntask: [general]\nmode: auto\n---\nbody", "scalar string"),
        ("request.md", "---\ntask: general\n---\nbody", "mode"),
        ("request.md", "---\ntask: general\nmode: auto\n---\n", "body"),
        ("request.md", "---\ntask: prototype\nmode: auto\n---\nbody", "does not authorize task"),
        ("request.md", "---\ntask: general\nmode: invalid\n---\nbody", "does not authorize mode"),
        ("request.md", "---\ntask: general\nmode: auto\n---\n$prototype do something else", "plain prompt"),
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
            GrantPolicy("general", frozenset({"interactive", "auto"})),
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
    policy = GrantPolicy("general", frozenset({"interactive", "auto"}))

    with pytest.raises(RequestFileError, match="direct child"):
        parse_request_file(nested, inbox, policy, parent_provider="claude")
    with pytest.raises(RequestFileError, match="canonical inbox"):
        parse_request_file(outside, inbox, policy, parent_provider="claude")


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
            GrantPolicy("general", frozenset({"interactive", "auto"})),
            parent_provider="claude",
        )


def configured_parent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> str:
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(sessions, "_visible_terminal", lambda *_args: None)
    monkeypatch.setattr(sessions, "_command_from_config", lambda _config, _provider="claude": ["claude"])
    return sessions.launch(provider="claude", cwd=tmp_path / "project")


def test_live_grant_processes_three_siblings_independently(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    parent = configured_parent(tmp_path, monkeypatch)
    grant = open_grant(parent, "ask-agent", original_cwd=tmp_path / "project")
    write_request(grant.inbox, "one.md", "---\ntask: general\nmode: auto\n---\n\nOne")
    write_request(grant.inbox, "bad.md", "---\ntask: prototype\nmode: auto\n---\n\nBad")
    write_request(grant.inbox, "two.md", "---\ntask: general\nmode: interactive\n---\n\nTwo")
    write_request(grant.inbox, "three.md", "---\ntask: general\nprovider: chatgpt\nmode: auto\n---\n\nThree")

    launched: list[tuple[str, str, str, Path]] = []
    results = process_grant(
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


def test_ask_requires_a_live_grant(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    configured_parent(tmp_path, monkeypatch)

    with pytest.raises(sessions.SessionError, match="live skill grant"):
        process_grant("not-a-grant", launch=lambda *_args: "never")


def test_grant_policy_is_the_exact_authorization_table() -> None:
    assert GRANT_POLICIES == {
        "ask-agent-to-explore": GrantPolicy("explore", frozenset({"auto"})),
        "ask-agent-to-prototype": GrantPolicy("prototype", frozenset({"interactive", "auto"})),
        "ask-agent-to-websearch": GrantPolicy("websearch", frozenset({"interactive", "auto"})),
        "ask-agent-to-brainstorm": GrantPolicy("brainstorm", frozenset({"interactive"})),
        "ask-agent": GrantPolicy("general", frozenset({"interactive", "auto"})),
    }


def test_uncertain_launch_is_reserved_before_the_external_call_and_never_retried(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    parent = configured_parent(tmp_path, monkeypatch)
    grant = open_grant(parent, "ask-agent", original_cwd=tmp_path / "project")
    request = write_request(grant.inbox, "one.md", "---\ntask: general\nmode: auto\n---\n\nOne")

    class SimulatedProcessDeath(BaseException):
        pass

    with pytest.raises(SimulatedProcessDeath):
        process_grant(grant.id, launch=lambda *_args: (_ for _ in ()).throw(SimulatedProcessDeath()))
    assert process_grant(grant.id, launch=lambda *_args: pytest.fail("uncertain launch duplicated")) == []

    connection = sqlite3.connect(tmp_path / "state" / "sessions.sqlite3")
    try:
        assert connection.execute("SELECT state FROM requests WHERE source_name = ?", (request.name,)).fetchone()[0] == "launching"
    finally:
        connection.close()
