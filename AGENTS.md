# AGENTS.md

## Project Shape

Harness is the canonical catalogue and installer for independently selectable agent skills, hooks,
command-line tools, and optional apps for Claude Code and ChatGPT. It also owns persistent visible-session
commands and ask/reply state.

`uvx --from <pinned source> harness` opens the only installer interface: one interactive catalogue menu.
Do not add named install, uninstall, upgrade, list, or info commands. The only named commands are `run`,
`ask`, `reply`, and `resume`.

## Repository Layout

- `src/harness_cli/`: Ephemeral Python installer, catalogue, platform adapters, receipts, settings
  merging, and TUI.
- `harness/productivity/subagents/`: Complete ask/reply bundle with internal provider hooks and an independently
  packaged persistent Python runtime.
- `harness/<category>/<tool>/`: installable packages. Start at the tool's `README.md`, or its platform `SKILL.md` when
  no README exists.
- `apps/aboard/`: independent npm monorepo boundary for the Aboard VS Code extension. Its local
  `AGENTS.md` is the navigation map for extension work.
- `tests/unit/`: installer, catalogue, platform, settings, receipt, and session tests.
- `tests/e2e/`: deterministic real-CLI E2E infrastructure shared with Aboard.
- `docs/CLAUDE-REFERENCES/`: mirrored official Claude Code documentation.
- `docs/CHATGPT-REFERENCES/`: mirrored official ChatGPT documentation.
- `docs/CHATGPT-COMPATIBILITY.md`: native ChatGPT target feasibility and implementation map.
- `scripts/update_references.py`: refreshes the mirrored upstream documentation.
- `harness/itsclaudehistory/`: nested Git repository; leave its internals alone unless explicitly asked.

## Catalogue Package Shape

Each installable tool lives below a category directory and has a `harness.toml` with `name`, `version`,
`description`, and at least one
`[[files]]` or `[[actions]]` entry. Bump `version` whenever its payload, fragment, dependency, or action
changes; a tool without a manifest is invisible to the installer.
Packages below `harness/archive/` are retained for reference and excluded from catalogue discovery.

Shared payloads live at the package root; shallow product folders are overlays:

```text
harness/<category>/<tool>/
├── harness.toml
├── README.md
├── SKILL.md          # one shared skill, with support files beside it
├── <skill>/         # each shared skill when a package contains several
├── <shared-hook>.py # one or two simple shared hook payloads
├── hooks/            # optional grouping for several related shared hooks
├── claude/           # shallow Claude-only files and settings.fragment.json
└── chatgpt/          # shallow ChatGPT-only files and hooks.fragment.json
```

Omit empty overlays. Keep manifests and product-neutral documentation at the tool root. A single-skill
package stores ChatGPT metadata at `chatgpt/openai.yaml`; a multi-skill package stores it at
`chatgpt/agents/<skill-name>.yaml`. Manifests map those sources to installed `skills/` and `hooks/`
destinations explicitly. Preserve real internal project trees such as `runtime/src/`; never mirror
installation roots inside overlays or restore a `targets/` override directory.

## Important Constraints

- The installer has explicit `claude` and `chatgpt` adapters. Declare target support under
  `[platforms.<name>]`; keep platform path mapping in the adapters, not installer call sites.
- `dependencies` contains package dependencies with explicit version constraints. `requires` is only for
  executables expected on `PATH`.
- Native settings fragments are merged as written and removed receipt-first without rewriting unrelated
  entries. Only use keys accepted by the target product's settings schema.
- Mark user-editable templates with `starter = true`; install them only when absent and never overwrite
  them later.
- `${PYTHON}` resolves to `uv run --no-project --no-managed-python` when `uv` is available, otherwise to
  the first interpreter that passes an execution check.
- Create a ChatGPT skill variant only for genuine product differences such as tool names, command
  injection, `$ARGUMENTS`, or reference variants. `disable-model-invocation` alone does not require a
  split; represent its ChatGPT policy in `agents/openai.yaml`.
- There is no legacy manifest, scaffold, installation, or receipt compatibility layer.
- `adress-this` and `review-this` contain mandatory empty user-owned prompt placeholders; do not author
  their bodies. The prototype, websearch, ask-agent, and reply-to-agent workflow prompts are also
  user-owned.
- Keep Aboard's npm build and release history independent. Do not flatten it into the Python package,
  bundle its VSIX in the wheel, or squash its repository history when merging it.

## Commands

From the repository root:

```powershell
uv sync
uv run harness
uv run pytest
uv run python scripts/update_references.py
```

For Aboard commands, work from `apps/aboard/` and follow its local `AGENTS.md`.

## Tests

- Run `uv run pytest` after catalogue or installer changes; the suite covers reconciliation and
  receipt-driven removal.
- Use the `harness-e2e` skill for work under `tests/e2e/` or `apps/aboard/e2e/`.
- Use the `tdd` skill before adding unit or E2E tests.
- Consult the mirrored official references for product behavior instead of relying on memory.

## References

- Use the `skill-prompt-engineering` skill when the user ask for writing/updating a SKILL.md file.
- See docs/CHATGPT-REFERENCES.md and docs/CLAUDE-REFERENCES.md for up to date ChatGPT or Claude Code official documentation. Complete your search with websearches if you can't find what you are looking for there.
