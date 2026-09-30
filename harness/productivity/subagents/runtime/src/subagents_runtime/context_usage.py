"""Read native transcript usage for optional loop report telemetry.

These are last-request measurements, not counts of pending messages/tool results.
Codex percentages reproduce the 12,000-token baseline used by its TUI (0.155–0.156).
No tokenizer or network request is needed.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

Provider = Literal["claude", "chatgpt"]
CapacitySource = Literal["transcript", "model", "override"]

# Confirmed capacities for the model IDs sampled in this project. Add explicit
# entries as models are validated; extended/custom provider windows use overrides.
# Checked 2026-09-30: platform.claude.com/docs/en/{models/overview,build-with-claude/context-windows}, code.claude.com/docs/en/model-config.
CLAUDE_CONTEXT_WINDOWS = {
    "claude-fable-5-1": 1_000_000,
    "claude-fable-5": 1_000_000,
    "claude-opus-5-5": 1_000_000,
    "claude-opus-5": 1_000_000,
    "claude-opus-4-8": 1_000_000,
    "claude-opus-4-7": 1_000_000,
    "claude-opus-4-6": 200_000,
    "claude-opus-4-5": 200_000,
    "claude-opus-4-5-20251101": 200_000,
    "claude-sonnet-5-5": 1_000_000,
    "claude-sonnet-5": 1_000_000,
    "claude-sonnet-4-6": 200_000,
    "claude-sonnet-4-5": 200_000,
    "claude-sonnet-4-5-20250929": 200_000,
    "claude-haiku-4-5": 200_000,
    "claude-haiku-4-5-20251001": 200_000,
}


@dataclass(frozen=True)
class ContextUsage:
    provider: Provider
    model: str | None
    used_tokens: int
    context_window: int | None
    capacity_source: CapacitySource | None
    measured_at: str | None

    @property
    def raw_used_percentage(self) -> float | None:
        """Simple token count / capacity, before provider display adjustments."""
        if self.context_window is None:
            return None
        return 100 * self.used_tokens / self.context_window

    @property
    def used_percentage(self) -> float | None:
        """TUI-equivalent percentage; None when maximum capacity is unknown."""
        window = self.context_window
        if window is None:
            return None
        if self.provider == "claude":
            return min(100.0, 100 * self.used_tokens / window)
        if window <= 12000:
            return 100.0
        remaining = max(0, window - 12000 - max(0, self.used_tokens - 12000))
        # Rust rounds nonnegative halves up; Python round uses ties-to-even.
        return 100.0 - math.floor(min(100.0, 100 * remaining / (window - 12000)) + 0.5)

    @property
    def remaining_percentage(self) -> float | None:
        used = self.used_percentage
        return None if used is None else 100 - used


def read_context_usage(
    transcript_path: str | Path,
    provider: Provider,
    *,
    context_window: int | None = None,
) -> ContextUsage | None:
    """Read native JSONL, not CLI stdout (whose usage can be cumulative).

    A missing file or usage returns None, including after compaction until a new
    request is measured. A caller-supplied positive capacity overrides metadata.
    An incomplete final JSONL line is ignored while a provider is writing it;
    other file errors and invalid complete JSON lines propagate.
    """
    if provider not in {"claude", "chatgpt"}:
        raise ValueError(f"unsupported provider {provider!r}")
    if context_window is not None and (
        type(context_window) is not int or context_window <= 0
    ):
        raise ValueError("context_window must be a positive integer")
    try:
        with Path(transcript_path).open(encoding="utf-8") as source:
            records = []
            for line in source:
                if not line.strip():
                    continue
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    if line.endswith("\n"):
                        raise
                    break
    except FileNotFoundError:
        return None
    records = [record for record in records if isinstance(record, dict)]
    if provider == "claude":
        return _claude_usage(records, context_window)
    model = None
    result = None
    for record in records:
        if not isinstance(record, dict):
            continue
        payload = record.get("payload")
        if record.get("type") == "compacted":
            result = None
            continue
        if not isinstance(payload, dict):
            continue
        if record.get("type") == "event_msg" and payload.get("type") == "context_compacted":
            result = None
            continue
        if record.get("type") == "turn_context":
            model = payload.get("model")
        if record.get("type") != "event_msg" or payload.get("type") != "token_count":
            continue
        info = payload.get("info")
        if not isinstance(info, dict):
            continue
        last = info.get("last_token_usage")
        tokens = last.get("total_tokens") if isinstance(last, dict) else None
        if type(tokens) is not int or tokens < 0:
            continue
        window = context_window if context_window is not None else info.get("model_context_window")
        if type(window) is not int or window <= 0:
            window = None
        result = ContextUsage(
            provider, model, tokens, window,
            ("override" if context_window is not None else "transcript") if window is not None else None,
            record.get("timestamp"),
        )
    return result


def _claude_usage(records: list[dict], context_window: int | None) -> ContextUsage | None:
    main = [record for record in records if not record.get("isSidechain")]
    by_id = {record["uuid"]: record for record in main if isinstance(record.get("uuid"), str)}
    # Native transcripts have a linked UUID chain. Detached branches and subagent
    # requests must not replace usage from the active conversation.
    leaf = next((record for record in reversed(main) if isinstance(record.get("uuid"), str)), None)
    chain = []
    seen = set()
    while leaf is not None and leaf["uuid"] not in seen:
        seen.add(leaf["uuid"])
        chain.append(leaf)
        leaf = by_id.get(leaf.get("parentUuid"))
    result = None
    for record in reversed(chain):
        if record.get("type") == "system" and record.get("subtype") == "compact_boundary":
            result = None
            continue
        message = record.get("message")
        if record.get("type") != "assistant" or not isinstance(message, dict):
            continue
        # Local errors/command replies can be persisted as assistant messages with
        # zero usage. They did not measure a model request and must not reset it.
        if message.get("model") == "<synthetic>":
            continue
        usage = message.get("usage")
        if not isinstance(usage, dict) or "input_tokens" not in usage:
            continue
        counts = [usage.get(key, 0) for key in (
            "input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens",
        )]
        if any(type(count) is not int or count < 0 for count in counts):
            continue
        model = message.get("model")
        model = model if isinstance(model, str) else None
        window = context_window if context_window is not None else CLAUDE_CONTEXT_WINDOWS.get(model)
        result = ContextUsage(
            "claude", model, sum(counts), window,
            ("override" if context_window is not None else "model") if window is not None else None,
            record.get("timestamp"),
        )
    return result
