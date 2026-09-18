import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / "harness/planning/grill-me-in-lavish"
sys.path.insert(0, str(PACKAGE))


def runtime():
    import grill_lavish_core
    return grill_lavish_core


def test_interview_reserves_fresh_paths_outside_project_and_recovers_on_resume(tmp_path):
    core = runtime()
    project = tmp_path / "project"
    project.mkdir()
    engine = core.InterviewRuntime(tmp_path / "runtime")
    first = engine.start("claude", "session", project)
    other = engine.start("claude", "other-session", project)
    assert not first.source.exists()
    assert first.source.parent.is_dir()
    assert not first.source.is_relative_to(project)
    assert first.assets.is_dir()
    assert list(first.assets.iterdir()) == []
    assert first.source != other.source
    resumed = core.InterviewRuntime(tmp_path / "runtime").current("claude", "session")
    assert resumed.source == first.source
    assert list(project.iterdir()) == []


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
        self.ended = []
        self.receipts = []
        self.feedback = feedback or {"session": {"status": "open"}, "prompts": [{"prompt": "Answer to Q1: Choice B"}]}

    def open(self, path):
        assert path.is_file()
        self.opened.append(path)

    def poll(self, path, receipt=None):
        self.receipts.append(receipt or path.parent / "feedback-receipt.json")
        return self.feedback

    def end(self, path):
        self.ended.append(path)


def test_complete_write_publishes_once_and_embeds_rich_html_safely(tmp_path):
    core = runtime()
    engine = core.InterviewRuntime(tmp_path / "runtime")
    interview = engine.start("claude", "session", tmp_path / "project")
    data = round_data()
    data["questions"][0]["explanation_html"] += "<p>Literal </script> stays in the payload</p>"
    interview.source.write_text(json.dumps(data), encoding="utf-8")
    lavish = Lavish()
    result = engine.publish("claude", "session", lavish)
    assert result.phase == "waiting"
    assert result.source != interview.source
    assert not result.source.exists()
    assert engine.publish("claude", "session", lavish).phase == "waiting"
    assert lavish.opened == [interview.board]
    html = interview.board.read_text(encoding="utf-8")
    embedded = html.split('<script id="grill-data" type="application/json">')[1].split("</script>")[0]
    assert json.loads(embedded)["questions"][0]["explanation_html"] == data["questions"][0]["explanation_html"]
    assert "__GRILL_ME_DATA__" not in html


@pytest.mark.parametrize("change", [
    lambda data: data["questions"][0].update(recommendation="D"),
    lambda data: data["questions"].append(data["questions"][0]),
    lambda data: data["questions"][0]["options"][1].update(letter="A"),
    lambda data: data["questions"][0]["options"][0].pop("detail"),
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
    assert interview.board.read_text(encoding="utf-8") == "previous round"
    assert lavish.opened == []


def test_feedback_survives_resume_and_advances_round_without_reopening(tmp_path):
    core = runtime()
    engine = core.InterviewRuntime(tmp_path / "runtime")
    interview = engine.start("chatgpt", "session", tmp_path / "project")
    interview.source.write_text(json.dumps(round_data()), encoding="utf-8")
    lavish = Lavish()
    engine.publish("chatgpt", "session", lavish)
    answered = engine.wait("chatgpt", "session", lavish)
    assert answered.feedback["prompts"][0]["prompt"] == "Answer to Q1: Choice B"
    assert answered.round == 2
    assert answered.phase == "ready"
    resumed = core.InterviewRuntime(tmp_path / "runtime").current("chatgpt", "session")
    assert resumed.feedback == answered.feedback
    resumed.source.write_text(json.dumps(round_data()), encoding="utf-8")
    engine.publish("chatgpt", "session", lavish)
    assert engine.current("chatgpt", "session").feedback is None
    assert lavish.opened == [interview.board]


@pytest.mark.parametrize("feedback", [
    {"session": {"status": "ended"}},
    {"session": {"status": "browser_disconnected"}},
    {"session": {"status": "feedback", "session_ended": True}, "prompts": [{"prompt": "Last answer"}]},
])
def test_ended_or_disconnected_review_does_not_automatically_reopen(tmp_path, feedback):
    engine = runtime().InterviewRuntime(tmp_path / "runtime")
    interview = engine.start("claude", "session", tmp_path / "project")
    interview.source.write_text(json.dumps(round_data()), encoding="utf-8")
    lavish = Lavish(feedback)
    engine.publish("claude", "session", lavish)
    stopped = engine.wait("claude", "session", lavish)
    assert stopped.phase == "paused"
    assert stopped.feedback == feedback
    assert engine.publish("claude", "session", lavish).phase == "paused"
    assert lavish.opened == [interview.board]


def test_completion_stops_waiting_without_opening_another_round(tmp_path):
    engine = runtime().InterviewRuntime(tmp_path / "runtime")
    interview = engine.start("claude", "session", tmp_path / "project")
    interview.source.write_text(json.dumps({"complete": True, "summary": "Decisions settled."}), encoding="utf-8")
    lavish = Lavish()
    assert engine.publish("claude", "session", lavish).phase == "complete"
    assert engine.wait("claude", "session", lavish).phase == "complete"
    assert lavish.opened == []


@pytest.mark.parametrize("provider, invocation", [("claude", "/grill-me-in-lavish"), ("chatgpt", "$grill-me-in-lavish")])
def test_hooks_deliver_feedback_once_then_allow_completion(tmp_path, provider, invocation):
    from grill_me_in_lavish_hook import handle
    engine = runtime().InterviewRuntime(tmp_path / "runtime")
    lavish = Lavish()
    common = {"session_id": "session", "cwd": str(tmp_path / "project")}
    assert handle(common | {"hook_event_name": "UserPromptSubmit", "prompt": invocation}, provider, engine, lavish)
    interview = engine.current(provider, "session")
    interview.source.write_text(json.dumps(round_data()), encoding="utf-8")
    # Shell writes have no structured file path: the expected source is enough.
    delivered = handle(common | {"hook_event_name": "PostToolUse", "tool_name": "Bash"}, provider, engine, lavish)
    assert delivered["hookSpecificOutput"]["hookEventName"] == "PostToolUse"
    assert handle(common | {"hook_event_name": "Stop", "stop_hook_active": True}, provider, engine, lavish) is None
    next_round = engine.current(provider, "session")
    next_round.source.write_text(json.dumps({"complete": True, "summary": "Agreed."}), encoding="utf-8")
    assert handle(common | {"hook_event_name": "Stop"}, provider, engine, lavish) is None
    assert lavish.opened == [interview.board]
    assert lavish.ended == [interview.board]


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_stop_recovers_a_write_that_missed_the_publication_hook(tmp_path, provider):
    from grill_me_in_lavish_hook import handle
    engine = runtime().InterviewRuntime(tmp_path / "runtime")
    interview = engine.start(provider, "session", tmp_path / "project")
    interview.source.write_text(json.dumps(round_data()), encoding="utf-8")
    delivered = handle({"hook_event_name": "Stop", "session_id": "session"}, provider, engine, Lavish())
    if provider == "chatgpt":
        assert delivered["decision"] == "block"
    else:
        assert delivered["hookSpecificOutput"]["hookEventName"] == "Stop"


def test_resume_of_waiting_round_does_not_supply_a_publishable_next_round(tmp_path):
    from grill_me_in_lavish_hook import handle
    engine = runtime().InterviewRuntime(tmp_path / "runtime")
    lavish = Lavish()
    interview = engine.start("claude", "session", tmp_path / "project")
    interview.source.write_text(json.dumps(round_data()), encoding="utf-8")
    engine.publish("claude", "session", lavish)
    assert engine.current("claude", "session").phase == "waiting"
    handle({"hook_event_name": "SessionStart", "session_id": "session"}, "claude", engine, lavish)
    # A premature next-round write cannot supersede answers still being reviewed.
    engine.current("claude", "session").source.write_text(json.dumps(round_data()), encoding="utf-8")
    assert engine.publish("claude", "session", lavish).phase == "waiting"
    engine.wait("claude", "session", lavish)
    assert not engine.current("claude", "session").source.exists()


def test_consumed_feedback_receipt_is_recovered_without_a_second_poll(tmp_path):
    engine = runtime().InterviewRuntime(tmp_path / "runtime")
    interview = engine.start("claude", "session", tmp_path / "project")
    interview.source.write_text(json.dumps(round_data()), encoding="utf-8")
    interview = engine.publish("claude", "session", Lavish())
    saved = {"session": {"status": "feedback"}, "prompts": [{"prompt": "My own answer"}]}
    interview.receipt.write_text(json.dumps(saved), encoding="utf-8")

    class MustNotPoll(Lavish):
        def poll(self, path, receipt=None):
            pytest.fail("Feedback was already consumed and persisted")

    assert engine.wait("claude", "session", MustNotPoll()).feedback == saved


def test_duplicate_hook_execution_cannot_claim_the_same_interview(tmp_path):
    engine = runtime().InterviewRuntime(tmp_path / "runtime")
    with engine.claim("claude", "session") as acquired:
        assert acquired
        with engine.claim("claude", "session") as duplicate:
            assert not duplicate
    with engine.claim("claude", "session") as acquired:
        assert acquired


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_catalogue_installs_a_working_renderer_and_removes_all_hooks(tmp_path, provider):
    from harness_cli.installer import CatalogueInstaller, Target
    from harness_cli.manifest import discover
    from harness_cli.receipts import ReceiptStore

    target = Target.for_project(tmp_path / "project", provider)
    installer = CatalogueInstaller(discover(), target, ReceiptStore.load(tmp_path / "receipts.json"))
    installer.reconcile({"grill-me-in-lavish"})
    hook = target.destination_path("hooks", "grill-lavish/grill_me_in_lavish_hook.py")
    assert hook.is_file()
    result = subprocess.run(
        [sys.executable, "-X", "utf8", "-c", "import json,sys; from grill_lavish_core import render_round; print(render_round(json.load(sys.stdin), 1))"],
        cwd=hook.parent, input=json.dumps(round_data()), capture_output=True, text=True, encoding="utf-8",
    )
    assert result.returncode == 0, result.stderr
    rendered = result.stdout
    assert '<script id="grill-data" type="application/json">' in rendered
    settings = json.loads(target.settings_path.read_text(encoding="utf-8"))
    assert {"SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"} <= settings["hooks"].keys()
    installer.reconcile(set())
    assert not hook.exists()
    assert not target.destination_path("hooks", "grill-lavish/assets/board-template.html").exists()
    settings = json.loads(target.settings_path.read_text(encoding="utf-8"))
    assert not any(group.get("hooks") for groups in settings.get("hooks", {}).values() for group in groups)


def test_chat_interruption_can_cancel_review_without_polling_or_claiming_agreement(tmp_path):
    from grill_me_in_lavish_hook import handle
    engine = runtime().InterviewRuntime(tmp_path / "runtime")
    interview = engine.start("claude", "session", tmp_path / "project")
    interview.source.write_text(json.dumps(round_data()), encoding="utf-8")
    lavish = Lavish()
    engine.publish("claude", "session", lavish)
    handle({"hook_event_name": "UserPromptSubmit", "session_id": "session", "prompt": "Cancel this interview"}, "claude", engine, lavish)
    current = engine.current("claude", "session")
    assert current.phase == "ready"
    current.source.write_text('{"cancel":true}', encoding="utf-8")

    class MustNotPoll(Lavish):
        def poll(self, path):
            pytest.fail("Cancelled reviews must not poll")

    cancelled = MustNotPoll()
    handle({"hook_event_name": "PostToolUse", "session_id": "session"}, "claude", engine, cancelled)
    assert engine.current("claude", "session").phase == "complete"
    assert lavish.opened == [interview.board]
    assert cancelled.ended == [interview.board]


def test_crash_after_feedback_commit_cannot_replay_answers_into_the_next_round(tmp_path, monkeypatch):
    engine = runtime().InterviewRuntime(tmp_path / "runtime")
    interview = engine.start("claude", "session", tmp_path / "project")
    interview.source.write_text(json.dumps(round_data()), encoding="utf-8")
    lavish = Lavish()
    engine.publish("claude", "session", lavish)
    unlink = Path.unlink

    def interrupted_cleanup(path, *args, **kwargs):
        if lavish.receipts and path == lavish.receipts[-1]:
            raise KeyboardInterrupt("Interrupted after feedback was committed")
        return unlink(path, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(Path, "unlink", interrupted_cleanup)
        with pytest.raises(KeyboardInterrupt):
            engine.wait("claude", "session", lavish)

    engine = runtime().InterviewRuntime(tmp_path / "runtime")
    recovered = engine.current("claude", "session")
    assert recovered.feedback == lavish.feedback
    assert recovered.round == 2
    next_data = round_data()
    next_data["questions"][0]["id"] = "Q2"
    recovered.source.write_text(json.dumps(next_data), encoding="utf-8")
    next_feedback = {"session": {"status": "feedback"}, "prompts": [{"prompt": "Answer to Q2: Explicitly"}]}
    lavish.feedback = next_feedback
    engine.publish("claude", "session", lavish)
    answered = engine.wait("claude", "session", lavish)
    assert answered.feedback == next_feedback
    assert answered.round == 3


def test_chat_revision_opens_an_isolated_review_without_old_queued_answers(tmp_path):
    from grill_me_in_lavish_hook import handle
    engine = runtime().InterviewRuntime(tmp_path / "runtime")
    original = engine.start("claude", "session", tmp_path / "project")
    data = round_data()
    data["questions"].append(round_data()["questions"][0] | {"id": "Q2"})
    original.source.write_text(json.dumps(data), encoding="utf-8")

    class QueuedReviews(Lavish):
        def __init__(self):
            super().__init__()
            self.queues = {}

        def poll(self, path, receipt=None):
            prompts = self.queues.pop(path, [])
            return {"session": {"status": "feedback" if prompts else "waiting"}, "prompts": prompts}

    lavish = QueuedReviews()
    engine.publish("claude", "session", lavish)
    lavish.queues[original.board] = [{"prompt": "Answer to Q2: Removed by revision"}]
    common = {"session_id": "session"}
    handle(common | {"hook_event_name": "UserPromptSubmit", "prompt": "Remove the second question"}, "claude", engine, lavish)
    engine.current("claude", "session").source.write_text(json.dumps(round_data()), encoding="utf-8")
    handle(common | {"hook_event_name": "PostToolUse"}, "claude", engine, lavish)
    revised = engine.current("claude", "session")
    assert revised.board != original.board
    assert original.board in lavish.ended
    assert revised.phase == "waiting"
    new_prompts = [{"prompt": "Answer to Q1: Revised answer"}]
    lavish.queues[revised.board] = new_prompts
    handle(common | {"hook_event_name": "Stop"}, "claude", engine, lavish)
    assert engine.current("claude", "session").feedback["prompts"] == new_prompts


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_paused_review_accepts_cancellation_without_polling_or_reopening(tmp_path, provider):
    from grill_me_in_lavish_hook import handle
    engine = runtime().InterviewRuntime(tmp_path / "runtime")
    interview = engine.start(provider, "session", tmp_path / "project")
    interview.source.write_text(json.dumps(round_data()), encoding="utf-8")

    class Disconnected(Lavish):
        def poll(self, path, receipt=None):
            raise RuntimeError("Connection lost")

    lavish = Disconnected()
    common = {"session_id": "session"}
    handle(common | {"hook_event_name": "PostToolUse"}, provider, engine, lavish)
    assert engine.current(provider, "session").phase == "paused"
    assert handle(common | {"hook_event_name": "UserPromptSubmit", "prompt": "Cancel this interview"}, provider, engine, lavish)
    paused = engine.current(provider, "session")
    assert not paused.source.exists()
    paused.source.write_text('{"cancel":true}', encoding="utf-8")
    handle(common | {"hook_event_name": "PostToolUse"}, provider, engine, lavish)
    assert engine.current(provider, "session").phase == "complete"
    assert lavish.opened == [interview.board]
    assert lavish.ended == [interview.board]


@pytest.mark.parametrize("event", ["SessionStart", "UserPromptSubmit"])
def test_resume_recovers_a_staged_round_before_supplying_another_source(tmp_path, event):
    from grill_me_in_lavish_hook import handle
    engine = runtime().InterviewRuntime(tmp_path / "runtime")
    staged = engine.start("claude", "session", tmp_path / "project")
    staged.source.write_text(json.dumps(round_data()), encoding="utf-8")
    lavish = Lavish()
    resumed = runtime().InterviewRuntime(tmp_path / "runtime")
    assert handle({"session_id": "session", "hook_event_name": event}, "claude", resumed, lavish)
    recovered = resumed.current("claude", "session")
    assert recovered.source != staged.source
    assert not recovered.source.exists()
    assert lavish.opened == [staged.board]
    assert lavish.receipts == []


def test_resume_of_an_invalid_staged_round_reserves_a_fresh_retry(tmp_path):
    from grill_me_in_lavish_hook import handle
    engine = runtime().InterviewRuntime(tmp_path / "runtime")
    staged = engine.start("chatgpt", "session", tmp_path / "project")
    staged.source.write_text('{"questions":[]}', encoding="utf-8")
    lavish = Lavish()
    assert handle({"session_id": "session", "hook_event_name": "SessionStart"}, "chatgpt", engine, lavish)
    retry = engine.current("chatgpt", "session")
    assert retry.source != staged.source
    assert not retry.source.exists()
    assert retry.phase == "ready"
    assert lavish.opened == []


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
@pytest.mark.parametrize("marker", [{"cancel": True}, {"complete": True, "summary": "Agreed solution"}])
def test_interrupted_terminal_cleanup_is_retried_on_resume(tmp_path, provider, marker):
    from grill_me_in_lavish_hook import handle
    engine = runtime().InterviewRuntime(tmp_path / "runtime")
    interview = engine.start(provider, "session", tmp_path / "project")
    interview.source.write_text(json.dumps(round_data()), encoding="utf-8")

    class InterruptedEnd(Lavish):
        interrupted = True

        def end(self, path):
            if self.interrupted:
                self.interrupted = False
                raise KeyboardInterrupt("Interrupted before ending the review")
            super().end(path)

    lavish = InterruptedEnd()
    engine.publish(provider, "session", lavish)
    common = {"session_id": "session"}
    handle(common | {"hook_event_name": "UserPromptSubmit", "prompt": "Finish the interview"}, provider, engine, lavish)
    engine.current(provider, "session").source.write_text(json.dumps(marker), encoding="utf-8")
    with pytest.raises(KeyboardInterrupt):
        handle(common | {"hook_event_name": "PostToolUse"}, provider, engine, lavish)
    assert engine.current(provider, "session").phase == "closing"
    recovered = runtime().InterviewRuntime(tmp_path / "runtime")
    handle(common | {"hook_event_name": "SessionStart"}, provider, recovered, lavish)
    assert recovered.current(provider, "session").phase == "complete"
    assert lavish.ended == [interview.board]
    assert lavish.opened == [interview.board]


@pytest.mark.parametrize("state", ["paused", "closing"])
def test_explicit_restart_closes_the_previous_review_before_reserving_a_new_one(tmp_path, state):
    from grill_me_in_lavish_hook import handle
    engine = runtime().InterviewRuntime(tmp_path / "runtime")
    original = engine.start("chatgpt", "session", tmp_path / "project")
    original.source.write_text(json.dumps(round_data()), encoding="utf-8")

    class FailedTransport(Lavish):
        failing = True

        def poll(self, path, receipt=None):
            raise RuntimeError("Connection lost")

        def end(self, path):
            if self.failing:
                raise RuntimeError("End request failed")
            super().end(path)

    lavish = FailedTransport()
    common = {"session_id": "session", "cwd": str(tmp_path / "project")}
    handle(common | {"hook_event_name": "PostToolUse"}, "chatgpt", engine, lavish)
    if state == "closing":
        engine.current("chatgpt", "session").source.write_text('{"cancel":true}', encoding="utf-8")
        handle(common | {"hook_event_name": "PostToolUse"}, "chatgpt", engine, lavish)
    assert engine.current("chatgpt", "session").phase == state
    lavish.failing = False
    assert handle(common | {"hook_event_name": "UserPromptSubmit", "prompt": "$grill-me-in-lavish Start again"}, "chatgpt", engine, lavish)
    restarted = engine.current("chatgpt", "session")
    assert restarted.directory != original.directory
    assert restarted.phase == "ready"
    assert not restarted.source.exists()
    assert lavish.ended == [original.board]


@pytest.mark.parametrize("provider", ["claude", "chatgpt"])
def test_cancellation_closes_a_review_opened_before_transport_failure(tmp_path, provider):
    from grill_me_in_lavish_hook import handle
    engine = runtime().InterviewRuntime(tmp_path / "runtime")
    original = engine.start(provider, "session", tmp_path / "project")
    original.source.write_text(json.dumps(round_data()), encoding="utf-8")

    class FailedOpenResponse(Lavish):
        def open(self, path):
            super().open(path)
            raise RuntimeError("Lost the response after opening the review")

        def poll(self, path, receipt=None):
            pytest.fail("Cancellation must not poll an uncertain open")

    lavish = FailedOpenResponse()
    common = {"session_id": "session"}
    handle(common | {"hook_event_name": "PostToolUse"}, provider, engine, lavish)
    assert engine.current(provider, "session").phase == "paused"
    resumed = runtime().InterviewRuntime(tmp_path / "runtime")
    handle(common | {"hook_event_name": "UserPromptSubmit", "prompt": "Cancel the interview"}, provider, resumed, lavish)
    resumed.current(provider, "session").source.write_text('{"cancel":true}', encoding="utf-8")
    handle(common | {"hook_event_name": "PostToolUse"}, provider, resumed, lavish)
    assert resumed.current(provider, "session").phase == "complete"
    assert lavish.opened == [original.board]
    assert lavish.ended == [original.board]
