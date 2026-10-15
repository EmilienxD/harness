import pytest

from subagents_runtime.effort import EFFORT_LEVELS, resolve_effort
from subagents_runtime.sessions import delegation_profile_arguments


@pytest.mark.parametrize("model", [
    "gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-terra",
])
@pytest.mark.parametrize("effort", EFFORT_LEVELS)
def test_codex_full_effort_models(model, effort):
    expected = "low" if effort in {"none", "minimal"} else effort
    assert resolve_effort("chatgpt", model, effort) == expected


@pytest.mark.parametrize("model", ["gpt-6-luna", "gpt-5.6-luna"])
@pytest.mark.parametrize("effort", EFFORT_LEVELS)
def test_luna_caps_effort(model, effort):
    expected = "low" if effort in {"none", "minimal"} else "max" if effort == "ultra" else effort
    assert resolve_effort("chatgpt", model, effort) == expected


@pytest.mark.parametrize("model", [
    "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5",
    "claude-sonnet-5-5", "claude-haiku-5-5",
])
@pytest.mark.parametrize("effort", EFFORT_LEVELS)
def test_claude_catalogue_efforts(model, effort):
    expected = "low" if effort in {"none", "minimal"} else "max" if effort == "ultra" else effort
    assert resolve_effort("claude", model, effort) == expected


def test_older_models_and_snapshots_use_supported_efforts():
    assert resolve_effort("claude", "claude-opus-4-6", "xhigh") == "high"
    assert resolve_effort("claude", "claude-sonnet-4-6", "max") == "max"
    assert resolve_effort("claude", "claude-haiku-4-5-20251001", "high") is None
    assert delegation_profile_arguments({}, "claude", "general",
        model_override="claude-haiku-4-5", effort_override="ultra") == ["--model", "claude-haiku-4-5"]


def test_unspecified_and_unknown_models_leave_native_resolution():
    assert resolve_effort("chatgpt", None, "ultra") == "ultra"
    assert resolve_effort("chatgpt", "future-model", "minimal") == "minimal"
    assert resolve_effort("claude", "opus", "ultra") == "max"
    assert resolve_effort("chatgpt", "gpt-6-luna", None) is None


def test_explicit_model_normalizes_inherited_profile_effort():
    config = {"providers": {"chatgpt": {"delegations": {"general": {"effort": "ultra"}}}}}
    assert delegation_profile_arguments(config, "chatgpt", "general", model_override="gpt-6-luna") == [
        "--model", "gpt-6-luna", "-c", 'model_reasoning_effort="max"',
    ]
