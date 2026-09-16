# AGENTS.md

## Project Shape

Harness is the canonical catalogue and installer for independently selectable agent skills, hooks,
command-line tools, and optional apps for Claude Code and ChatGPT. It also owns persistent visible-session
commands and ask/reply state.

`uvx --from <pinned source> harness` opens the interactive catalogue menu by default and also exposes the
non-interactive installer commands `install`, `uninstall`, `upgrade`, `list`, and `info`. Keep installer
operations distinct from the persistent-session commands `run`, `ask`, `reply`, and `resume`.

## Repository Layout

- `src/harness_cli/`: Ephemeral Python installer, catalogue, platform adapters, receipts, settings
  merging, and TUI.
- `harness/productivity/subagents/`: Complete ask/reply bundle with internal provider hooks and an independently
  packaged persistent Python runtime.
- `harness/<category>/<tool>/`: installable packages. User-facing documentation is centralized in the root
  `README.md`; inspect a platform `SKILL.md` only when implementation details are needed.
- `apps/aboard/`: the sole documentation exception, with its own user-facing `README.md` and local `AGENTS.md`
  navigation map.
- `tests/unit/`: installer, catalogue, platform, settings, receipt, and session tests.
- `tests/e2e/`: deterministic real-CLI E2E infrastructure shared with Aboard.
- `docs/CLAUDE-REFERENCES/`: mirrored official Claude Code documentation.
- `docs/CHATGPT-REFERENCES/`: mirrored official ChatGPT documentation.
- `docs/CHATGPT-COMPATIBILITY.md`: native ChatGPT target feasibility and implementation map.
- `scripts/update_references.py`: refreshes the mirrored upstream documentation.

## Catalogue Package Shape

Each installable tool lives below a category directory and has a `harness.toml` with `name`, `version`,
`description`, and at least one
`[[files]]` or `[[actions]]` entry. Bump `version` whenever its payload, fragment, dependency, or action
changes; a tool without a manifest is invisible to the installer.
Packages below `harness/archived/` and `harness/deprecated/` are retained for reference and excluded from catalogue discovery.

Shared payloads live at the package root; shallow product folders are overlays:

```text
harness/<category>/<tool>/
├── harness.toml
├── SKILL.md          # one shared skill, with support files beside it
├── <skill>/         # each shared skill when a package contains several
├── <tool_name>_hook.py  # the package's single hook, shared by every provider
├── <support>.py     # modules the hook imports, installed beside it
├── claude/           # shallow Claude-only files and settings.fragment.json
└── chatgpt/          # shallow ChatGPT-only files and hooks.fragment.json
```

Omit empty overlays. Keep manifests and product-neutral documentation at the tool root. A single-skill
package stores ChatGPT metadata at `chatgpt/openai.yaml`; a multi-skill package stores it at
`chatgpt/agents/<skill-name>.yaml`. Manifests map those sources to installed `skills/` and `hooks/`
destinations explicitly. Preserve real internal project trees such as `runtime/src/`; never mirror
installation roots inside overlays or restore a `targets/` override directory.

## Commands

From the repository root:

```powershell
uv sync
uv run harness
uv run harness --help
uv run pytest
uv run python scripts/update_references.py docs/CLAUDE-REFERENCES docs/CHATGPT-REFERENCES
```

For Aboard commands, work from `apps/aboard/` and follow its local `AGENTS.md`.

## Tests

- Run `uv run pytest` after catalogue or installer changes; the suite covers reconciliation and
  receipt-driven removal.
- Use the `harness-e2e` skill for work under `tests/e2e/` or `apps/aboard/test/e2e/`.
- MANDATORY before writing unit or e2e tests: to know how to write tests and when, invoke the `tdd` skill. Skip for fast, obvious fixes; reserve it for large, complex work.
- Consult the mirrored official references for product behavior instead of relying on memory.
- Never assert exact or partial equality against agent prompt strings, because prompt text is not a meaningful contract and checks like the presence of "review" are useless.

## References

- Use the `writing-for-agents` skill when the user ask for writing/updating a SKILL.md file.
- See `docs/CHATGPT-REFERENCES/` and `docs/CLAUDE-REFERENCES/` for up-to-date ChatGPT or Claude Code official documentation. Complete your search with web searches if you cannot find what you need there.
