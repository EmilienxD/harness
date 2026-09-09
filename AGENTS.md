# AGENTS.md

## Project Shape

Harness is the canonical catalogue and installer for independently selectable agent skills, hooks,
command-line tools, and optional apps for Claude Code and ChatGPT. It also owns persistent visible-session
commands and ask/reply state.

`uvx --from <pinned source> harness` opens the only installer interface: one interactive catalogue menu.
Do not add named install, uninstall, upgrade, list, or info commands. The only named commands are `run`,
`ask`, `reply`, and `resume`.

## Repository Layout

- `src/harness_cli/`: Python installer, catalogue, platform adapters, receipts, settings merging, TUI, and
  persistent session commands.
- `harness/<tool>/`: installable packages. Start at the tool's `README.md`, or its platform `SKILL.md` when
  no README exists.
- `apps/aboard/`: independent npm monorepo boundary for the Aboard VS Code extension. Its local
  `AGENTS.md` is the navigation map for extension work.
- `tests/`: installer, catalogue, platform, settings, receipt, and session tests.
- `e2e/`: deterministic real-CLI E2E infrastructure shared with Aboard.
- `docs/CLAUDE-REFERENCES/`: mirrored official Claude Code documentation.
- `docs/CHATGPT-REFERENCES/`: mirrored official ChatGPT documentation.
- `docs/CHATGPT-COMPATIBILITY.md`: native ChatGPT target feasibility and implementation map.
- `scripts/update_references.py`: refreshes the mirrored upstream documentation.
- `harness/itsclaudehistory/`: nested Git repository; leave its internals alone unless explicitly asked.

## Catalogue Package Shape

Each installable tool has a `harness.toml` with `name`, `version`, `description`, and at least one
`[[files]]` or `[[actions]]` entry. Bump `version` whenever its payload, fragment, dependency, or action
changes; a tool without a manifest is invisible to the installer.

Payloads use sibling layers:

```text
harness/<tool>/
├── harness.toml
├── README.md
├── shared/          # installed unchanged for both products
├── claude/          # Claude-native variants and metadata
└── chatgpt/         # ChatGPT-native variants and metadata
```

Omit empty layers. Keep manifests and product-neutral documentation at the tool root. Mirror logical
roots such as `hooks/` and `skills/` inside payload layers; never use one product as another's implicit
source tree or restore a `targets/` override directory.

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
- `address-issue` and `issue-review` contain mandatory empty user-owned prompt placeholders; do not author
  their bodies. The prototype, websearch, ask-agent, and communicate-to-agent workflow prompts are also
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

## Tests and References

- Run `uv run pytest` after catalogue or installer changes; the suite covers reconciliation and
  receipt-driven removal.
- Use the `harness-e2e` skill for work under `e2e/` or `apps/aboard/e2e/`.
- Use the `tdd` skill before adding unit or E2E tests.
- Consult the mirrored official references for product behavior instead of relying on memory.
