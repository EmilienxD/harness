import json
from pathlib import Path

from subagents_runtime.cli import main
from subagents_runtime.storage import connect


def test_watch_shows_background_research_from_standalone_execution(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path))
    with connect() as db:
        db.execute("INSERT INTO sessions(id,cwd) VALUES ('parent',?)", (str(tmp_path),))
        db.execute("INSERT INTO sessions(id,cwd,provider,execution_mode,parent_session_id,agent_index) VALUES ('child',?,'claude','auto','parent',1)", (str(tmp_path),))
        db.execute("INSERT INTO executions(id,session_id,backend,state,started_at) VALUES ('execution','child','standalone','running','2026-09-26 10:00:00')")
    log = tmp_path / "runtime" / "sessions" / "parent" / "executions" / "execution" / "stdout.jsonl"
    log.parent.mkdir(parents=True)
    log.write_text('\n'.join([
        json.dumps({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "WebSearch", "input": {"query": "current evidence"}}]}}),
        json.dumps({"type": "result", "result": "The answer is complete."}),
    ]) + '\n', encoding="utf-8")

    monkeypatch.setenv("HARNESS_SESSION_ID", "parent")
    assert main(["watch", "agent-1", "--once"]) == 0
    output = capsys.readouterr().out
    assert "Search started: current evidence" in output
    assert "Finished" in output


def test_watch_reads_aboard_execution_from_shared_watch_log(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("HARNESS_STATE_DIR", str(tmp_path))
    monkeypatch.chdir(tmp_path)
    with connect() as db:
        db.execute("INSERT INTO sessions(id,cwd,provider,execution_mode) VALUES ('session',?,'chatgpt','auto')", (str(tmp_path),))
        db.execute("INSERT INTO executions(id,session_id,backend,state) VALUES ('execution','session','aboard','running')")
    log = tmp_path / "runtime" / "watch" / "execution" / "stdout.jsonl"
    log.parent.mkdir(parents=True)
    log.write_text(json.dumps({"type": "item.started", "item": {"id": "1", "type": "web_search", "query": "live sources"}}) + "\n", encoding="utf-8")

    assert main(["watch", "session", "--once"]) == 0
    assert "Search started: live sources" in capsys.readouterr().out
    assert main(["watch", "--once"]) == 0
    assert "Search started: live sources" in capsys.readouterr().out


def test_claude_result_reports_usage_when_present():
    from subagents_runtime.progress import event_summary

    assert event_summary({"type": "result", "usage": {"input_tokens": 140, "output_tokens": 30}}) == "Finished · 140 input, 30 output tokens"
