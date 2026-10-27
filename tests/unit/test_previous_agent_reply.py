import json
from pathlib import Path

import pytest

from subagents_runtime import hooks, sessions
from subagents_runtime.delegation import (
    arm_reply, claim_parent_delivery, enable_delegation, process_inbox,
)
from subagents_runtime.previous_message import PreviousMessageError, read_previous_message


@pytest.fixture
def child_request(tmp_path, monkeypatch):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    for name in ("HARNESS_SESSION_ID", "HARNESS_EXECUTION_ID"):
        monkeypatch.delenv(name, raising=False)
    sessions.register_observed("parent", tmp_path, "claude")
    inbox = enable_delegation("parent", "subagents-toolkit").inbox
    (inbox / "work.md").write_text(
        "---\nmode: interactive\n---\nWork.", encoding="utf-8",
    )
    [result] = process_inbox("parent", launch=lambda *_args: "native-child")
    assert result.status == "launched", result.reason
    assert result.child_session_id is not None
    return result


def transcript(tmp_path, provider, text="  test\nunchanged  "):
    if provider == "claude":
        records = [
            {"type": "user", "uuid": "user", "parentUuid": None},
            {"type": "assistant", "uuid": "answer", "parentUuid": "user", "message": {
                "id": "answer-id", "role": "assistant", "model": "claude-haiku-5-5",
                "content": [{"type": "thinking", "thinking": "private"}, {"type": "text", "text": text}],
            }},
            {"type": "user", "uuid": "command", "parentUuid": "answer"},
            {"type": "assistant", "isSidechain": True, "uuid": "other", "message": {
                "content": [{"type": "text", "text": "other agent"}],
            }},
            {"type": "assistant", "uuid": "error", "parentUuid": "command", "message": {
                "model": "<synthetic>", "content": [{"type": "text", "text": "local error"}],
            }},
        ]
    else:
        records = [
            {"type": "response_item", "payload": {"type": "message", "role": "user",
                "content": [{"type": "input_text", "text": "Work."}]}},
            {"type": "response_item", "payload": {"type": "message", "role": "assistant",
                "phase": "final_answer", "content": [{"type": "output_text", "text": text}]}},
            {"type": "event_msg", "payload": {"type": "task_complete", "last_agent_message": text}},
            {"type": "response_item", "payload": {"type": "message", "role": "assistant",
                "phase": "commentary", "content": [{"type": "output_text", "text": "progress"}]}},
        ]
    path = tmp_path / "transcript.jsonl"
    path.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")
    return path


def request_payload(child, path, provider, invocation="plain"):
    prefix = "/" if provider == "claude" else "$"
    command = prefix + hooks.PREVIOUS_REPLY_SKILL
    if invocation == "linked":
        command = f"[{command}](C:/skills/{hooks.PREVIOUS_REPLY_SKILL}/SKILL.md)"
    return {"session_id": child, "hook_event_name": "UserPromptSubmit", "prompt": command,
            "transcript_path": str(path), "cwd": str(path.parent)}


@pytest.mark.parametrize(("provider", "invocation"), [
    ("claude", "plain"), ("chatgpt", "plain"), ("chatgpt", "linked"), ("claude", "expansion"),
])
def test_previous_reply_blocks_without_model_context_and_delivers_exact_response(
    tmp_path, monkeypatch, child_request, provider, invocation,
):
    path = transcript(tmp_path, provider)
    payload = request_payload(child_request.child_session_id, path, provider, invocation)
    if invocation == "expansion":
        payload.update(hook_event_name="UserPromptExpansion", command_name=hooks.PREVIOUS_REPLY_SKILL)
    monkeypatch.setattr(hooks, "claim_instructions", lambda *_args, **_kwargs: pytest.fail("model context claimed"))
    monkeypatch.setattr(hooks, "claim_parent_delivery", lambda *_args: pytest.fail("child deliveries consumed"))

    output = hooks.handle(payload, provider)

    assert output["decision"] == "block"
    assert "additionalContext" not in output.get("hookSpecificOutput", {})
    with sessions._connect() as connection:
        row = connection.execute("SELECT state,reply,delivery_id FROM requests WHERE id=?", (child_request.request_id,)).fetchone()
        assert row[0] == "succeeded"
        assert row[1] == "  test\nunchanged  "
        assert row[2]
        assert connection.execute("SELECT count(*) FROM reply_authorizations").fetchone() == (0,)
    delivery = claim_parent_delivery("parent", "Stop")
    assert delivery is not None and row[1] in delivery.text
    hooks.handle(payload, provider)
    with sessions._connect() as connection:
        assert connection.execute("SELECT delivery_id,reply FROM requests WHERE id=?", (child_request.request_id,)).fetchone() == (row[2], row[1])


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
@pytest.mark.parametrize("contents", ["", '{}\n', '{"type":"user"}\n', 'not json\n'])
def test_no_previous_message_blocks_and_keeps_request_pending(
    tmp_path, child_request, provider, contents,
):
    path = tmp_path / "empty.jsonl"
    path.write_text(contents, encoding="utf-8")
    arm_reply(child_request.child_session_id)
    output = hooks.handle(request_payload(child_request.child_session_id, path, provider), provider)
    assert output["decision"] == "block"
    assert "additionalContext" not in output.get("hookSpecificOutput", {})
    with sessions._connect() as connection:
        assert connection.execute("SELECT state,reply,delivery_id FROM requests WHERE id=?", (child_request.request_id,)).fetchone() == ("pending", None, None)
        assert connection.execute("SELECT count(*) FROM reply_authorizations").fetchone() == (1,)


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_unrelated_execution_cannot_send_the_reply(tmp_path, monkeypatch, child_request, provider):
    monkeypatch.setenv("HARNESS_EXECUTION_ID", "unrelated-execution")
    path = transcript(tmp_path, provider)
    output = hooks.handle(request_payload(child_request.child_session_id, path, provider), provider)
    assert output["decision"] == "block"
    with sessions._connect() as connection:
        assert connection.execute("SELECT state,reply FROM requests WHERE id=?", (child_request.request_id,)).fetchone() == ("pending", None)


def test_no_parent_request_blocks_without_sending(tmp_path, monkeypatch):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.delenv("HARNESS_SESSION_ID", raising=False)
    monkeypatch.delenv("HARNESS_EXECUTION_ID", raising=False)
    path = transcript(tmp_path, "claude")
    output = hooks.handle(request_payload("independent", path, "claude"), "claude")
    assert output["decision"] == "block"
    with sessions._connect() as connection:
        assert connection.execute("SELECT count(*) FROM requests").fetchone() == (0,)


def test_transcript_lookup_stays_on_active_claude_branch(tmp_path):
    path = transcript(tmp_path, "claude", "chosen")
    with path.open("a", encoding="utf-8") as target:
        target.write(json.dumps({"type": "assistant", "uuid": "detached", "parentUuid": None,
            "message": {"content": [{"type": "text", "text": "detached"}]}}) + "\n")
        target.write(json.dumps({"type": "user", "uuid": "active", "parentUuid": "error"}) + "\n")
    assert read_previous_message(str(path), "claude") == "chosen"


def test_missing_transcript_returns_error(tmp_path):
    with pytest.raises(PreviousMessageError):
        read_previous_message(str(tmp_path / "missing.jsonl"), "claude")
