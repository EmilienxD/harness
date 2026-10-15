"""Resolve requested effort at the provider boundary without changing task prompts."""

EFFORT_LEVELS = ("none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra")
_CLAUDE = ("low", "medium", "high", "xhigh", "max")
_CODEX = ("low", "medium", "high", "xhigh", "max", "ultra")

# CLI capabilities, checked 2026-10-15. Codex Ultra orchestrates subagents;
# API reasoning-effort tables alone do not describe this CLI capability.
# https://learn.chatgpt.com/docs/models
# https://code.claude.com/docs/en/model-config#adjust-effort-level
# Codex's models_cache.json supplies the per-model CLI level arrays, including
# the older 5.6 models whose complete CLI matrix is absent from the web docs.
_MODEL_EFFORTS = {
    "gpt-6.1-sol": _CODEX,
    "gpt-6-astra": _CODEX,
    "gpt-6-sol": _CODEX,
    "gpt-6-luna": _CODEX[:-1],
    "gpt-5.6-sol": _CODEX,
    "gpt-5.6-terra": _CODEX,
    "gpt-5.6-luna": _CODEX[:-1],
    "claude-fable-5-1": _CLAUDE,
    "claude-fable-5": _CLAUDE,
    "claude-opus-5-5": _CLAUDE,
    "claude-opus-5": _CLAUDE,
    "claude-sonnet-5-5": _CLAUDE,
    "claude-sonnet-5": _CLAUDE,
    "claude-haiku-5-5": _CLAUDE,
    "claude-opus-4-8": _CLAUDE,
    "claude-opus-4-7": _CLAUDE,
    "claude-opus-4-6": ("low", "medium", "high", "max"),
    "claude-sonnet-4-6": ("low", "medium", "high", "max"),
    "claude-opus-4-5": (),
    "claude-opus-4-1": (),
    "claude-opus-4": (),
    "claude-sonnet-4-5": (),
    "claude-sonnet-4": (),
    "claude-haiku-4-5": (),
}


def resolve_effort(provider: str, model: str | None, effort: str | None) -> str | None:
    """Choose the closest supported level, preferring the lower one on a tie.

    Unspecified models and aliases retain native model resolution. Unknown
    Codex models retain CLI-valid values so new models need no allowlist update.
    """
    if effort is None:
        return None
    supported = _MODEL_EFFORTS.get(model)
    if supported is None and model is not None:
        # Full model IDs can carry dated snapshot suffixes.
        supported = next((levels for name, levels in _MODEL_EFFORTS.items()
                          if model.startswith(name + "-")), None)
    if supported is None:
        supported = _CLAUDE if provider == "claude" else EFFORT_LEVELS
    if not supported:
        return None
    requested = EFFORT_LEVELS.index(effort)
    return min(supported, key=lambda level: (
        abs(EFFORT_LEVELS.index(level) - requested), EFFORT_LEVELS.index(level)
    ))
