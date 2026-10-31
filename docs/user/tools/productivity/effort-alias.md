# Effort alias

Platforms: **Pi**. Install with `harness install effort-alias --platform pi`; see [installation and scope](../../getting-started.md).

`effort-alias` adds `/effort [level]` as an alternative to `/thinking` for changing
the current session's reasoning effort without inference.

```powershell
uv run harness install effort-alias --platform pi --scope user
```

Restart Pi or run `/reload`, then use `/effort high` or `/effort` to open a picker.
Explicit levels are case-insensitive. Choices follow the active model's supported
levels; invalid or unsupported levels leave the setting unchanged. Cancelling the
picker does nothing. In a non-interactive host, supply a level explicitly.

## Implementation and limits

Pi exposes no public built-in command dispatcher. This extension uses Pi's shared
`getSupportedThinkingLevels` helper and public `getThinkingLevel`/`setThinkingLevel`
APIs instead of submitting `/thinking` as an agent prompt. The picker is a standard
extension selector, not the native thinking selector. It changes session effort
only; use native `/thinking` and its save shortcut to change startup defaults.
No private host methods, prompt expansion, or model requests are involved.

## Verification

Focused installation tests cover project and user package installation, removal,
Pi-only support, and preservation of unrelated settings and extensions. The real
Pi loader/session test covers explicit levels, case normalization, picker selection
and cancellation, invalid and model-unsupported levels, unchanged startup defaults,
and zero agent starts. Run it with:

```powershell
uv run pytest tests/unit/test_effort_alias_catalogue.py -q
node tests/unit/effort_alias_host.mjs <installed-Pi-package-directory>
```

The host check exercises extension loading and command dispatch with a controlled
UI adapter; it is not a terminal-rendering or keyboard-interaction test.
