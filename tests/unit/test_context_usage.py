import json

import pytest

from subagents_runtime.context_usage import read_context_usage


def write_transcript(path, *records):
    path.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")
    return path


def test_codex_reads_latest_request_and_matches_tui_percentage(tmp_path):
    transcript = write_transcript(
        tmp_path / "codex.jsonl",
        {"type": "turn_context", "payload": {"model": "gpt-6-sol"}},
        {"type": "event_msg", "timestamp": "2026-09-24T17:03:46Z", "payload": {
            "type": "token_count", "info": {
                "last_token_usage": {"total_tokens": 61091, "cached_input_tokens": 60544},
                "total_token_usage": {"total_tokens": 1316170},
                "model_context_window": 258400,
            },
        }},
        {"type": "event_msg", "payload": {"type": "token_count", "info": None}},
    )

    usage = read_context_usage(transcript, "chatgpt")

    assert usage.used_tokens == 61091
    assert usage.context_window == 258400
    assert usage.capacity_source == "transcript"
    assert usage.model == "gpt-6-sol"
    assert usage.used_percentage == 20
    assert usage.remaining_percentage == 80
    assert usage.measured_at == "2026-09-24T17:03:46Z"


@pytest.mark.parametrize("model,capacity,percentage", [
    ("claude-opus-5-5", 1000000, 9.9531),
    ("claude-sonnet-4-5", 200000, 49.7655),
    ("unknown-model", None, None),
])
def test_claude_reads_active_branch_input_and_keeps_unknown_capacity(tmp_path, model, capacity, percentage):
    transcript = write_transcript(
        tmp_path / "claude.jsonl",
        {"type": "assistant", "uuid": "old", "parentUuid": None, "message": {
            "model": model, "usage": {"input_tokens": 999999},
        }},
        {"type": "user", "uuid": "question", "parentUuid": None},
        {"type": "assistant", "uuid": "answer", "parentUuid": "question", "message": {
            "model": model, "usage": {"input_tokens": 2, "cache_creation_input_tokens": 814,
                                     "cache_read_input_tokens": 98715, "output_tokens": 742},
        }},
        {"type": "assistant", "uuid": "local-error", "parentUuid": "answer", "message": {
            "model": "<synthetic>", "usage": {"input_tokens": 0, "output_tokens": 0},
        }},
        {"type": "assistant", "uuid": "child", "isSidechain": True, "message": {
            "model": model, "usage": {"input_tokens": 500000},
        }},
    )

    usage = read_context_usage(transcript, "claude")

    assert usage.used_tokens == 99531
    assert usage.context_window == capacity
    if percentage is None:
        assert usage.used_percentage is None
    else:
        assert usage.used_percentage == pytest.approx(percentage)
    assert usage.capacity_source == ("model" if capacity else None)
    overridden = read_context_usage(transcript, "claude", context_window=200000)
    assert overridden.used_percentage == pytest.approx(49.7655)
    assert overridden.capacity_source == "override"


@pytest.mark.parametrize("provider", ["chatgpt", "claude"])
def test_compaction_discards_old_usage_until_a_new_measurement(tmp_path, provider):
    if provider == "chatgpt":
        records = [
            {"type": "event_msg", "payload": {"type": "token_count", "info": {
                "last_token_usage": {"total_tokens": 61091}, "model_context_window": 258400,
            }}},
            {"type": "compacted", "payload": {}},
        ]
        new_measurement = {"type": "event_msg", "payload": {"type": "token_count", "info": {
            "last_token_usage": {"total_tokens": 10000}, "model_context_window": 258400,
        }}}
    else:
        records = [
            {"type": "assistant", "uuid": "before", "parentUuid": None, "message": {
                "model": "claude-opus-5-5", "usage": {"input_tokens": 99531},
            }},
            {"type": "system", "subtype": "compact_boundary", "uuid": "boundary", "parentUuid": "before"},
        ]
        new_measurement = {"type": "assistant", "uuid": "after", "parentUuid": "boundary", "message": {
            "model": "claude-opus-5-5", "usage": {"input_tokens": 10000},
        }}
    transcript = write_transcript(tmp_path / "compacted.jsonl", *records)

    assert read_context_usage(transcript, provider) is None

    write_transcript(transcript, *records, new_measurement)
    usage = read_context_usage(transcript, provider)
    assert usage.used_tokens == 10000
    assert usage.used_percentage == (0 if provider == "chatgpt" else 1)


def test_live_transcript_keeps_last_complete_measurement_and_unknown_window(tmp_path):
    transcript = tmp_path / "live.jsonl"
    assert read_context_usage(transcript, "chatgpt") is None
    write_transcript(transcript, {"type": "event_msg", "payload": {"type": "token_count", "info": {
        "last_token_usage": {"total_tokens": 0}, "model_context_window": None,
    }}})
    with transcript.open("a", encoding="utf-8") as source:
        source.write('{"type":"event_msg","payload":')

    usage = read_context_usage(transcript, "chatgpt")

    assert usage.used_tokens == 0  # A genuine zero count is distinct from no measurement.
    assert usage.used_percentage is None
    assert usage.remaining_percentage is None
    assert read_context_usage(transcript, "chatgpt", context_window=200000).used_percentage == 0
