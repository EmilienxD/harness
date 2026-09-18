import copy
import json
import subprocess
import sys
from dataclasses import replace
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / "harness/planning/grill-me-in-lavish"
sys.path.insert(0, str(PACKAGE))


def runtime():
    import grill_lavish_core
    return grill_lavish_core


def round_data():
    return {"questions": [{
        "id": "Q1", "question": "When should publication happen?",
        "explanation_html": "<p>Publication commits the round.</p><table><tr><td>After writing</td></tr></table>",
        "recommendation": "B",
        "options": [
            {"letter": "A", "label": "Automatically", "detail": "One write publishes."},
            {"letter": "B", "label": "Explicitly", "detail": "A separate step publishes."},
        ],
        "init_js": "root.dataset.initialized = 'yes';",
    }]}


class Lavish:
    def __init__(self, feedback=None):
        self.opened = []
        self.polled = []
        self.feedback = feedback or {"session": {"status": "feedback"}, "prompts": [{"prompt": "Answer to Q1: Choice B"}]}

    def open(self, path):
        assert path.is_file()
        self.opened.append(path)

    def poll(self, path):
        self.polled.append(path)
        return self.feedback


def test_interview_reserves_fresh_paths_outside_project(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    engine = runtime().InterviewRuntime(tmp_path / "runtime")
    first = engine.start("claude", "session", project)
    other = engine.start("claude", "other-session", project)
    assert not first.source.exists()
    assert first.source.parent.is_dir()
    assert not first.source.is_relative_to(project)
    assert first.assets.is_dir()
    assert list(first.assets.iterdir()) == []
    assert first.source != other.source
    assert runtime().InterviewRuntime(tmp_path / "runtime").current("claude", "session").source == first.source
    assert list(project.iterdir()) == []


def test_runtime_rejects_inboxes_inside_project(tmp_path):
    project = tmp_path / "project"
    with pytest.raises(ValueError):
        runtime().InterviewRuntime(project / "runtime").start("claude", "session", project)


def test_new_file_publishes_once_and_embeds_rich_html_safely(tmp_path):
    engine = runtime().InterviewRuntime(tmp_path / "runtime")
    interview = engine.start("claude", "session", tmp_path / "project")
    data = round_data()
    data["questions"][0]["explanation_html"] += "<p>Literal </script> stays in the payload</p>"
    interview.source.write_text(json.dumps(data), encoding="utf-8")
    lavish = Lavish()
    feedback, feedback_file = engine.publish("claude", "session", lavish)
    assert feedback == lavish.feedback
    assert json.loads(feedback_file.read_text(encoding="utf-8")) == feedback
    next_round = engine.current("claude", "session")
    assert next_round.source != interview.source
    assert not next_round.source.exists()
    assert not next_round.waiting
    assert engine.publish("claude", "session", lavish) is None
    assert lavish.opened == lavish.polled == [interview.board]
    html = interview.board.read_text(encoding="utf-8")
    embedded = html.split('<script id="grill-data" type="application/json">')[1].split("</script>")[0]
    assert json.loads(embedded)["questions"][0]["explanation_html"] == data["questions"][0]["explanation_html"]
    assert "__GRILL_ME_DATA__" not in html


@pytest.mark.parametrize("change", [
    lambda data: data["questions"][0].update(recommendation="D"),
    lambda data: data["questions"].append(data["questions"][0]),
    lambda data: data["questions"][0]["options"][1].update(letter="A"),
    lambda data: data["questions"][0]["options"][0].pop("detail"),
    lambda data: data["questions"][0].update(init_js=42),
    lambda data: data.update(questions=[]),
])
def test_invalid_round_keeps_previous_board_and_reserves_fresh_retry(tmp_path, change):
    core = runtime()
    engine = core.InterviewRuntime(tmp_path / "runtime")
    interview = engine.start("claude", "session", tmp_path / "project")
    interview.board.write_text("previous round", encoding="utf-8")
    data = round_data()
    change(data)
    interview.source.write_text(json.dumps(data), encoding="utf-8")
    lavish = Lavish()
    with pytest.raises(core.RoundError):
        engine.publish("claude", "session", lavish)
    retry = engine.current("claude", "session")
    assert retry.source != interview.source
    assert not retry.source.exists()
    assert retry.assets.is_dir()
    assert interview.board.read_text(encoding="utf-8") == "previous round"
    assert lavish.opened == lavish.polled == []


@pytest.mark.parametrize("provider, invocation", [("claude", "/grill-me-in-lavish"), ("chatgpt", "$grill-me-in-lavish")])
def test_delivered_answers_leave_later_prompts_and_session_events_quiet(tmp_path, provider, invocation):
    from grill_me_in_lavish_hook import handle
    engine = runtime().InterviewRuntime(tmp_path / "runtime")
    lavish = Lavish()
    common = {"session_id": "session", "cwd": str(tmp_path / "project")}
    assert handle(common | {"hook_event_name": "UserPromptSubmit", "prompt": invocation}, provider, engine, lavish)
    interview = engine.current(provider, "session")
    interview.source.write_text(json.dumps(round_data()), encoding="utf-8")
    delivered = handle(common | {"hook_event_name": "PostToolUse", "tool_name": "Bash"}, provider, engine, lavish)
    assert delivered["hookSpecificOutput"]["hookEventName"] == "PostToolUse"
    for event in ("UserPromptSubmit", "Stop", "SessionStart", "PostToolUse"):
        assert handle(common | {"hook_event_name": event, "prompt": "Work on another task"}, provider, engine, lavish) is None
    assert lavish.opened == lavish.polled == [interview.board]
    # A second file, rather than any session event, starts the next wait.
    next_round = engine.current(provider, "session")
    next_round.source.write_text(json.dumps(round_data()), encoding="utf-8")
    assert handle(common | {"hook_event_name": "PostToolUse"}, provider, engine, lavish)
    assert lavish.opened == [interview.board]
    assert lavish.polled == [interview.board, interview.board]
    assert engine.current(provider, "session").round == 3


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_interrupted_round_is_not_polled_again_by_later_tools(tmp_path, provider):
    from grill_me_in_lavish_hook import handle
    engine = runtime().InterviewRuntime(tmp_path / "runtime")
    interview = engine.start(provider, "session", tmp_path / "project")
    interview.source.write_text(json.dumps(round_data()), encoding="utf-8")

    class InterruptedPoll(Lavish):
        def poll(self, path):
            self.polled.append(path)
            if len(self.polled) > 1:
                pytest.fail("A later tool must not restart the abandoned poll")
            raise KeyboardInterrupt

    lavish = InterruptedPoll()
    common = {"session_id": "session"}
    with pytest.raises(KeyboardInterrupt):
        handle(common | {"hook_event_name": "PostToolUse"}, provider, engine, lavish)
    for event in ("PostToolUse", "Stop", "SessionStart"):
        assert handle(common | {"hook_event_name": event}, provider, engine, lavish) is None
    assert lavish.opened == lavish.polled == [interview.board]


def test_chat_revision_uses_a_separate_review_without_old_queued_answers(tmp_path):
    from grill_me_in_lavish_hook import handle
    engine = runtime().InterviewRuntime(tmp_path / "runtime")
    original = engine.start("claude", "session", tmp_path / "project")
    original.source.write_text(json.dumps(round_data()), encoding="utf-8")

    class QueuedReviews(Lavish):
        def __init__(self):
            super().__init__()
            self.queues = {}

        def poll(self, path):
            self.polled.append(path)
            if path == original.board:
                raise KeyboardInterrupt
            return {"session": {"status": "feedback"}, "prompts": self.queues.pop(path)}

    lavish = QueuedReviews()
    common = {"session_id": "session"}
    with pytest.raises(KeyboardInterrupt):
        handle(common | {"hook_event_name": "PostToolUse"}, "claude", engine, lavish)
    lavish.queues[original.board] = [{"prompt": "Answer to Q1: Abandoned answer"}]
    assert handle(common | {"hook_event_name": "UserPromptSubmit", "prompt": "Revise the question"}, "claude", engine, lavish)
    revised = engine.current("claude", "session")
    assert revised.board != original.board
    assert not revised.source.exists()
    new_prompts = [{"prompt": "Answer to Q1: Revised answer"}]
    lavish.queues[revised.board] = new_prompts
    revised.source.write_text(json.dumps(round_data()), encoding="utf-8")
    assert handle(common | {"hook_event_name": "PostToolUse"}, "claude", engine, lavish)
    assert lavish.opened == [original.board, revised.board]
    saved = json.loads((revised.directory / "feedback-002.json").read_text(encoding="utf-8"))
    assert saved["prompts"] == new_prompts


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_chat_discards_a_staged_round_instead_of_recovering_it(tmp_path, provider):
    from grill_me_in_lavish_hook import handle
    engine = runtime().InterviewRuntime(tmp_path / "runtime")
    staged = engine.start(provider, "session", tmp_path / "project")
    staged.source.write_text(json.dumps(round_data()), encoding="utf-8")
    lavish = Lavish()
    common = {"session_id": "session"}
    for event in ("SessionStart", "Stop"):
        assert handle(common | {"hook_event_name": event}, provider, engine, lavish) is None
    handle(common | {"hook_event_name": "UserPromptSubmit", "prompt": "Change tasks"}, provider, engine, lavish)
    assert handle(common | {"hook_event_name": "PostToolUse"}, provider, engine, lavish) is None
    assert engine.current(provider, "session").source != staged.source
    assert lavish.opened == lavish.polled == []


@pytest.mark.parametrize("mode", ["open", "poll"])
def test_transport_failure_is_reported_once_without_later_retries(tmp_path, mode):
    from grill_me_in_lavish_hook import handle
    engine = runtime().InterviewRuntime(tmp_path / "runtime")
    interview = engine.start("chatgpt", "session", tmp_path / "project")
    interview.source.write_text(json.dumps(round_data()), encoding="utf-8")
    lavish = Lavish()

    def fail(path):
        raise RuntimeError("Connection lost")

    setattr(lavish, mode, fail)
    common = {"session_id": "session"}
    assert handle(common | {"hook_event_name": "PostToolUse"}, "chatgpt", engine, lavish)
    for event in ("PostToolUse", "SessionStart", "Stop", "UserPromptSubmit"):
        assert handle(common | {"hook_event_name": event}, "chatgpt", engine, lavish) is None


@pytest.mark.parametrize("feedback", [
    {"session": {"status": "ended"}},
    {"session": {"status": "browser_disconnected"}},
    {"session": {"status": "feedback", "session_ended": True}, "prompts": [{"prompt": "Last answer"}]},
])
def test_ended_or_disconnected_review_stays_quiet_until_explicit_invocation(tmp_path, feedback):
    from grill_me_in_lavish_hook import handle
    engine = runtime().InterviewRuntime(tmp_path / "runtime")
    interview = engine.start("claude", "session", tmp_path / "project")
    interview.source.write_text(json.dumps(round_data()), encoding="utf-8")
    lavish = Lavish(feedback)
    common = {"session_id": "session", "cwd": str(tmp_path / "project")}
    assert handle(common | {"hook_event_name": "PostToolUse"}, "claude", engine, lavish)
    assert handle(common | {"hook_event_name": "UserPromptSubmit", "prompt": "Continue in chat"}, "claude", engine, lavish) is None
    assert lavish.opened == lavish.polled == [interview.board]
    assert handle(common | {"hook_event_name": "UserPromptSubmit", "prompt": "/grill-me-in-lavish"}, "claude", engine, lavish)
    new_review = engine.current("claude", "session")
    assert new_review.board != interview.board
    new_review.source.write_text(json.dumps(round_data()), encoding="utf-8")
    assert handle(common | {"hook_event_name": "PostToolUse"}, "claude", engine, lavish)
    assert lavish.opened == [interview.board, new_review.board]


def test_large_feedback_is_saved_entirely_with_a_short_hook_response(tmp_path):
    from grill_me_in_lavish_hook import handle
    engine = runtime().InterviewRuntime(tmp_path / "runtime")
    interview = engine.start("chatgpt", "session", tmp_path / "project")
    interview.source.write_text(json.dumps(round_data()), encoding="utf-8")
    feedback = {"session": {"status": "feedback"}, "prompts": [{"prompt": "Details " * 2000, "attachments": [{"path": "example.png"}]}]}
    output = handle({"session_id": "session", "hook_event_name": "PostToolUse"}, "chatgpt", engine, Lavish(feedback))
    assert len(json.dumps(output)) < 3000
    assert json.loads((interview.directory / "feedback-001.json").read_text(encoding="utf-8")) == feedback


def test_rendering_failure_keeps_the_same_round_for_repair(tmp_path):
    engine = runtime().InterviewRuntime(tmp_path / "runtime")
    interview = engine.start("claude", "session", tmp_path / "project")
    interview.source.write_text(json.dumps(round_data()), encoding="utf-8")
    engine.publish("claude", "session", Lavish({"session": {"status": "feedback"}, "artifact_failures": [{"message": "Example failed"}]}))
    assert engine.current("claude", "session").round == 1


def test_duplicate_hook_execution_cannot_publish_the_same_round(tmp_path):
    from grill_me_in_lavish_hook import handle
    engine = runtime().InterviewRuntime(tmp_path / "runtime")
    interview = engine.start("claude", "session", tmp_path / "project")
    interview.source.write_text(json.dumps(round_data()), encoding="utf-8")
    lavish = Lavish()
    payload = {"session_id": "session", "hook_event_name": "PostToolUse"}
    with engine.claim("claude", "session") as acquired:
        assert acquired
        assert handle(payload, "claude", engine, lavish) is None
    assert handle(payload, "claude", engine, lavish)
    assert lavish.polled == [interview.board]


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_catalogue_upgrade_removes_recovery_hooks_and_uninstall_removes_payloads(tmp_path, provider):
    from harness_cli.installer import CatalogueInstaller, Target
    from harness_cli.manifest import discover
    from harness_cli.platforms import Platform
    from harness_cli.receipts import ReceiptStore

    tools = discover()
    tool = tools["grill-me-in-lavish"]
    platform = Platform.parse(provider)
    legacy = copy.deepcopy(tool.fragment_for(platform))
    legacy["hooks"]["Stop"] = copy.deepcopy(legacy["hooks"]["PostToolUse"])
    legacy["hooks"]["SessionStart"] = copy.deepcopy(legacy["hooks"]["UserPromptSubmit"])
    old_tool = replace(tool, version="1.1.1", platform_fragments=tool.platform_fragments | {platform: legacy})
    target = Target.for_project(tmp_path / "project", provider)
    receipt_path = tmp_path / "receipts.json"
    CatalogueInstaller({tool.name: old_tool}, target, ReceiptStore.load(receipt_path)).reconcile({tool.name})
    installer = CatalogueInstaller(tools, target, ReceiptStore.load(receipt_path))
    installer.reconcile({tool.name})
    hook = target.destination_path("hooks", "grill-lavish/grill_me_in_lavish_hook.py")
    assert hook.is_file()
    result = subprocess.run(
        [sys.executable, "-X", "utf8", "-c", "import json,sys; from grill_lavish_core import render_round; print(render_round(json.load(sys.stdin), 1))"],
        cwd=hook.parent, input=json.dumps(round_data()), capture_output=True, text=True, encoding="utf-8",
    )
    assert result.returncode == 0, result.stderr
    assert '<script id="grill-data" type="application/json">' in result.stdout
    settings = json.loads(target.settings_path.read_text(encoding="utf-8"))
    active_events = {event for event, groups in settings["hooks"].items() if any(group.get("hooks") for group in groups)}
    assert active_events == {"UserPromptSubmit", "PostToolUse"}
    installer.reconcile(set())
    assert not hook.exists()
    assert not target.destination_path("hooks", "grill-lavish/assets/board-template.html").exists()
    settings = json.loads(target.settings_path.read_text(encoding="utf-8"))
    assert not any(group.get("hooks") for groups in settings.get("hooks", {}).values() for group in groups)
